"""Pure categorisation-rule matching, shared by every path that applies rules.

Rules are applied in more than one place — "Apply my rules" sweeps charges ALREADY
stored (BankSync only applies rules at sync time, to incoming charges — WHIT-502), and
the merchant-grouping preview counts what a minted rule would file. WHIT-526 adds a
third: the webhook, as charges land. The matching logic has to live ONCE so those paths
can never disagree, so it lives here in the shared layer.

Matching is LITERAL — what BankSync itself would do with the same leaf rule — NOT the
fuzzy merchant-similarity gate the client's "every charge from this merchant" sweep uses.
A rule is by definition "description contains VALUE" / "category equals VALUE".

No I/O and NO `from constants import`: this is a flat shared-layer module (the layer is
staged with a non-recursive `cp shared/*.py`, and `lambda_api/constants.py` shadows the
shared constants at runtime — AGENTS.md), so it stays pure and constants-free. Stdlib
`re` + `hashlib` only.
"""

import hashlib
import re
from decimal import Decimal, InvalidOperation

# The (field, operator) pairs the engine can evaluate — the SOURCE OF TRUTH for the match
# vocabulary. `lambda_api/constants.py` (RULE_FIELDS/RULE_OPERATORS) mirrors this for request
# validation and MUST be widened in lockstep: the engine is constants-free (the shared-layer
# staging + shadow landmine, see the module docstring), so the two lists are unlinked and a field
# the validator accepts but the engine can't evaluate silently matches nothing.
#   description/merchant: `contains` (substring) + `equals` (exact, folded).
#   category: `equals` — a raw-enum mapping (FOOD_AND_DRINK -> groceries) for rules made outside
#             the app; unfiled rows carry raw enums, so it is worth honouring when present.
#   account: `equals` against the internal account_id.
#   amount: `less_than`/`less_than_or_equal`/`greater_than`/`greater_than_or_equal` a plain positive
#           dollar value, compared to the charge's MAGNITUDE (abs) — spend is stored negative, so
#           "under $30" means abs(amount) < 30.
#   direction: `is` "debit" (spend, amount < 0) / "credit" (income, amount > 0).
_FIELD_OPERATORS = {
    "description": {"contains", "equals"},
    "merchant": {"contains", "equals"},
    "category": {"equals"},
    "account": {"equals"},
    "amount": {"less_than", "less_than_or_equal", "greater_than", "greater_than_or_equal"},
    "direction": {"is"},
}

# The two ways a multi-condition rule combines its conditions: "all" = AND, "any" = OR.
_LOGIC = {"all", "any"}

# Back-compat shorthands for the two shapes that predate multi-condition rules (WHIT-541).
_DESCRIPTION_CONTAINS = ("description", "contains")
_CATEGORY_EQUALS = ("category", "equals")

# How many example descriptions each rule shows in the preview.
_SAMPLES_PER_RULE = 3


def fold(value: str) -> str:
    """Fold a rule value for duplicate-matching, mirroring the client's
    normaliseRuleIdentity (src/context.tsx): trim, lowercase, collapse internal
    whitespace runs. Case + spacing vary for the same merchant, so an exact-value
    compare would miss real duplicates. `str(...)` guards a non-string value so the
    fail-open lookup can't raise. The two folds are only
    guaranteed equal for ASCII (Python `.lower()` and JS `toLowerCase()` disagree on
    a few non-ASCII chars) — fine for the AU merchant strings this matches.

    Deliberately DIFFERENT from `_normalise`: this COLLAPSES internal whitespace, the
    right latitude for dedup identity but too wide for matching. See `_normalise`.
    """
    return re.sub(r"\s+", " ", str(value or "").strip().lower())


def rule_id_for(field: str, operator: str, value: str) -> str:
    """Stable dedup id for a leaf rule: the first 16 hex chars of
    sha256("field|operator|folded value").

    `field` and `operator` are matched literally (a closed vocabulary — description/contains,
    category/equals), so they go in raw; only `value` is folded, so case- and spacing-variants
    of the same merchant collapse to ONE id. The id IS the duplicate guard: our rule store keys
    a row on it, so "the same rule twice" lands on the same row by construction (WHIT-528).
    """
    digest = hashlib.sha256(f"{field}|{operator}|{fold(value)}".encode("utf-8")).hexdigest()
    return digest[:16]


def _condition_key(condition: dict) -> str:
    """The canonical string for one condition — `field|operator|folded value`, the SAME string
    rule_id_for hashes for a single rule. So a 1-condition rule collapses to the legacy id."""
    return f"{condition.get('field')}|{condition.get('operator')}|{fold(condition.get('value'))}"


def rule_id_for_conditions(conditions: list[dict], logic: str) -> str:
    """Stable id for a (possibly multi-) condition rule (WHIT-541).

    A SINGLE condition collapses to the EXACT legacy `rule_id_for` id — so an existing rule keeps
    its id (and every charge stamped `filed_by_rule=<id>` stays attached) and a rule built one
    condition at a time in the new UI dedups against the old flat rule. Two or more conditions hash
    `logic` + the SORTED condition keys: sorted so `[A AND B]` and `[B AND A]` are one rule, and
    prefixed with `logic::` so a multi id can never collide with a legacy `field|operator|value` one.
    """
    if len(conditions) == 1:
        condition = conditions[0]
        return rule_id_for(condition.get("field"), condition.get("operator"), condition.get("value"))
    canonical = f"{logic}::" + "&&".join(sorted(_condition_key(condition) for condition in conditions))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def _normalise(value) -> str:
    """Trim + lowercase, both sides of a comparison.

    Deliberately NOT `fold`: `fold` also collapses internal whitespace runs, which is the
    right latitude for dedup identity but wider than matching wants. With collapsing, a rule
    value "coles online" would match a description "COLES  ONLINE", quietly matching text the
    rule doesn't literally contain.

    Case-insensitive because descriptions arrive upper-case while users type mixed case, and
    BankSync's own case behaviour is unverified — the preview shows exactly what would be filed
    before anything is written, so erring toward matching is safe here.
    """
    return str(value or "").strip().lower()


def contains(value, normalised_text) -> bool:
    """The literal `value contains` primitive: trim + lowercase the value, then test membership
    in ALREADY-normalised text. The one place both `rule_matches` (which normalises the charge
    description via `_normalise`) and merchant_groups (which folds its descriptions once, up
    front) do the actual comparison — so the two can't drift into different match semantics.

    NOT whitespace-COLLAPSING (see `_normalise`): a looser compare would let a "COLES" group
    swallow "NICOLE'S CAFE" / "COLES  ONLINE" and overstate a count right before a bulk write.
    """
    return value.strip().lower() in normalised_text


def _text_matches(operator: str, value_text: str, target_text: str) -> bool:
    """The `contains` / `equals` primitive over already-normalised text. One place, so description
    and merchant can't drift into different match semantics."""
    if operator == "contains":
        return contains(value_text, target_text)
    if operator == "equals":
        return value_text == target_text
    return False


def _amount_matches(operator: str, value, amount) -> bool:
    """Compare a charge's amount MAGNITUDE (abs) against a plain positive dollar `value`. Spend is
    stored negative, so "under $30" means abs(amount) < 30 (WHIT-541 decision: amount is plain
    dollars, direction is a separate condition). A missing amount or a non-numeric value fails
    closed — matching the fold-open convention rules use everywhere else."""
    if amount is None:
        return False
    try:
        threshold = Decimal(str(value))
        magnitude = abs(Decimal(str(amount)))
    except (InvalidOperation, TypeError, ValueError):
        return False
    if operator == "less_than":
        return magnitude < threshold
    if operator == "less_than_or_equal":
        return magnitude <= threshold
    if operator == "greater_than":
        return magnitude > threshold
    if operator == "greater_than_or_equal":
        return magnitude >= threshold
    return False


def _direction_matches(value, amount) -> bool:
    """"debit" = spend (amount < 0), "credit" = income (amount > 0). Zero and a missing/non-numeric
    amount match neither."""
    if amount is None:
        return False
    try:
        signed = Decimal(str(amount))
    except (InvalidOperation, TypeError, ValueError):
        return False
    if value == "debit":
        return signed < 0
    if value == "credit":
        return signed > 0
    return False


def _condition_matches(condition: dict, transaction: dict) -> bool:
    """Does ONE `{field, operator, value}` condition hold for this charge? Unknown field/operator
    -> False (the caller skips unsupported rules rather than silently ignoring them)."""
    field = condition.get("field")
    operator = condition.get("operator")
    value = condition.get("value")
    if field == "amount":
        return _amount_matches(operator, value, transaction.get("amount"))
    if field == "direction":
        return operator == "is" and _direction_matches(value, transaction.get("amount"))
    if field == "account":
        return operator == "equals" and bool(value) and value == transaction.get("account_id")
    text = _normalise(value)
    if not text:
        return False
    if field in ("description", "merchant"):
        # 'merchant' matches the RAW description, not the cleaned merchant_name: description is the
        # field every other rule matches and it's stable across a charge's life, whereas
        # merchant_name is a lossy display name whose source differs pending vs posted (banksync.py
        # / clean_merchant), so matching it silently misses charges for the same merchant.
        return _text_matches(operator, text, _normalise(transaction.get("description")))
    if field == "category":
        return operator == "equals" and text == _normalise(transaction.get("category"))
    return False


def _conditions_of(rule: dict) -> tuple[list[dict], str]:
    """The rule's `(conditions, logic)`. A multi-condition rule (WHIT-541) carries `conditions` +
    `logic`; a legacy/single rule is read as ONE condition from its flat field/operator/value, so
    both shapes evaluate through the one path. An unknown logic defaults to "all" (AND)."""
    conditions = rule.get("conditions")
    if conditions:
        logic = rule.get("logic")
        return conditions, (logic if logic in _LOGIC else "all")
    return [{"field": rule.get("field"), "operator": rule.get("operator"),
             "value": rule.get("value")}], "all"


def rule_matches(rule: dict, transaction: dict) -> bool:
    """Does this rule match this stored charge? Evaluates each condition and combines them by the
    rule's logic — "all" (AND) or "any" (OR); a single-condition rule reads as one condition.
    Unknown field/operator -> that condition is False.

    `_conditions_of` always yields a non-empty list (a rule with no `conditions` reads as its one
    flat condition), so the empty-list guard below is only defensive — no stored rule reaches it."""
    conditions, logic = _conditions_of(rule)
    if not conditions:
        return False
    combine = all if logic == "all" else any
    return combine(_condition_matches(condition, transaction) for condition in conditions)


def reevaluatable_after_fill(rule: dict) -> bool:
    """After this rule FILED a charge, can re-running ``rule_matches`` on that charge be trusted?

    Yes, UNLESS the rule matches on the ``category`` field: filing overwrites the charge's category
    with the rule's target, so a ``category equals X`` condition would no longer match its own
    already-filed charge and re-evaluation would wrongly un-file it. Every other field the engine
    reads (description, merchant, amount, direction, account) is untouched by filing, so a match on
    those stays authoritative. Reads the same ``conditions``/flat shape as ``rule_matches``, so a
    single-condition rule and each condition of a multi rule (WHIT-541) are both checked — the whole
    reason a multi ``merchant AND amount`` rule is safe to re-evaluate even though only its FIRST
    flat field is ``merchant``. Used by the WHIT-540 edit re-file to decide between re-evaluating and
    a blind re-file."""
    conditions, _logic = _conditions_of(rule)
    return all(condition.get("field") != "category" for condition in conditions)


def existing_at_least_as_specific(rule: dict, field: str, operator: str, value: str) -> bool:
    """Would minting a rule for `<field> <operator> <value>` be unsafe against this EXISTING rule,
    so the caller must refuse it?

    True when the existing rule is at least as specific as (or identical to) the candidate — i.e.
    the candidate's folded value is a substring of the existing rule's folded value. The candidate
    is then more GENERAL (or exact): it matches a superset of the existing rule's charges, and the
    "file this shop" flow narrows the sweep to ONLY the minted rule, so minting the general
    candidate would file the existing specific rule's charges to the candidate's category —
    steamrolling it. The caller refuses that (a clash).

    False when the candidate is STRICTLY more specific (the existing value sits inside it, e.g.
    existing "COLES" vs candidate "COLES EXPRESS"): minting is safe — the narrowed sweep files only
    the candidate's own charges, and a full "Apply my rules" resolves any overlap the same way by
    most-specific-wins (WHIT-518). Non-nested values ("COLES" vs "RICHMOND") are also False: they
    may co-occur in one description but that isn't decidable from the values, so it isn't refused
    here (reported as `conflicted` if it ever bites).
    """
    if (rule.get("field"), rule.get("operator")) != (field, operator):
        return False
    existing, candidate = fold(rule.get("value")), fold(value)
    if not existing or not candidate:
        return False
    return candidate in existing


def is_unfiled_category(category: str | None, taxonomy_ids) -> bool:
    """Server twin of the client's categoryIsUnmapped (src/context.tsx): a charge is
    uncategorized when its category is null OR a raw value not in the user's taxonomy,
    excluding income. One place so the count and the /breakdown bucket can't drift from
    each other or from the client. Budget contribution is a SEPARATE gate a caller adds."""
    return category != "income" and category not in taxonomy_ids


def _skip_reason(rule: dict, is_unfiled) -> str | None:
    """Why this rule can't be applied, or None if it can.

    A rule whose target category is itself "unfiled" (a deleted category's dangling
    id, or a raw value never in the taxonomy) is load-bearing for safe-to-run-twice:
    filing a charge to it would leave the charge still unfiled, so the next run would
    file it again, forever. Using the SAME predicate the caller uses to pick eligible
    charges makes "filing a charge removes it from the unfiled set" true by
    construction (and correctly accepts `income`, which is filed but not a taxonomy id).
    """
    conditions, _logic = _conditions_of(rule)
    if not conditions:
        return "empty rule value"
    for condition in conditions:
        field, operator = condition.get("field"), condition.get("operator")
        if field not in _FIELD_OPERATORS or operator not in _FIELD_OPERATORS[field]:
            return "unsupported rule type"
        # A text condition with an empty value would match nothing (or, on `contains`, everything);
        # amount/direction carry no text value, so they are exempt.
        if field not in ("amount", "direction") and not _normalise(condition.get("value")):
            return "empty rule value"
    # Distinguished from the next check so the reason doesn't lie: a foreign rule that never had
    # a category at all is a different problem from one whose category was deleted.
    if not rule.get("categoryId"):
        return "rule has no category"
    if is_unfiled(rule["categoryId"]):
        return "category no longer exists"
    return None


def decide(rules: list[dict], charge: dict) -> tuple[str | None, list[int], set[str]]:
    """Resolve which category `rules` would file `charge` into — the per-charge core both the
    preview (`plan_rule_application`) and the webhook (WHIT-528) share.

    Returns `(resolved_category, matched_indices, categories)`:
      resolved_category — the sole matched categoryId, or None. None for BOTH "no rule matched"
                          AND "matching rules disagree": a conflict must never be silently
                          decided (WHIT-355), so the caller distinguishes the two via `categories`.
      matched_indices   — positional indices into `rules` of every rule that matches, in order,
                          so the caller can count per-rule hits (indices, NOT ids: an inline rule
                          carries id=None, and two of them must stay separate).
      categories        — the set of categoryIds the matching rules name.

    `rules` is the candidate list the caller already narrowed; `decide` does no skip filtering
    of its own, and reads each matching rule's `categoryId` directly — so every rule passed MUST
    carry one (run it through `_skip_reason` first, as `plan_rule_application` does). A caller
    that feeds unfiltered rules — including one with no category — is a bug in the caller.
    """
    matched_indices = []
    categories = set()
    for index, rule in enumerate(rules):
        if not rule_matches(rule, charge):
            continue
        matched_indices.append(index)
        categories.add(rule["categoryId"])

    # No match, or matching rules all agree — the sole (or absent) category resolves it.
    if len(categories) <= 1:
        return next(iter(categories), None), matched_indices, categories

    # They disagree: the MORE SPECIFIC rule wins (WHIT-518). A matching rule is "dominant" when it
    # is more specific than every OTHER match — SAME field+operator AND its folded value contains
    # theirs ("coles express" contains "coles"). The field+operator guard matters: containment
    # across kinds ("transfer" sitting inside the raw enum "transfer_out") is a coincidence, not
    # specificity, so a mixed-kind disagreement has no winner. If the dominant rules agree on one
    # category, file to it and float that rule to matched_indices[0] (both stamp sites read index
    # 0). Otherwise (a genuine ambiguity like "coles" vs "richmond") the charge stays conflicted.
    matched_rules = [rules[index] for index in matched_indices]
    # Multi-condition rules (WHIT-541) don't reduce to a single value, so the "more specific wins"
    # containment test below can't rank them. A disagreement involving one has no specificity
    # winner -> the charge stays conflicted (unfiled), the safe outcome (the WHIT-355 runtime net).
    if any(rule.get("conditions") for rule in matched_rules):
        return None, matched_indices, categories
    folded_values = [fold(rule.get("value")) for rule in matched_rules]
    targets = [(rule.get("field"), rule.get("operator")) for rule in matched_rules]
    dominant_positions = [
        position for position in range(len(matched_rules))
        if all(targets[other] == targets[position] and folded_values[other] in folded_values[position]
               for other in range(len(matched_rules)))
    ]
    winning_categories = {matched_rules[position]["categoryId"] for position in dominant_positions}
    if len(winning_categories) != 1:
        return None, matched_indices, categories

    resolved = winning_categories.pop()
    winner = dominant_positions[0]
    matched_indices.insert(0, matched_indices.pop(winner))
    return resolved, matched_indices, categories


def plan_rule_application(rules: list[dict], transactions: list[dict], is_unfiled) -> dict:
    """What applying `rules` to `transactions` would do — decided, not done.

    `is_unfiled(category)` is the caller's "this charge still needs filing" predicate
    (the same one the badge counts with), so this module never has its own opinion of
    what "uncategorized" means.

    A charge matched by rules that DISAGREE on the category is counted in `conflicted`
    and left alone — a conflict must never be silently decided (WHIT-355). Charges
    matched by rules that agree are filed once. Each `matched` entry is a
    `(transaction, category, rule_id)` tuple — rule_id is the winning rule's id (WHIT-536).

    `by_rule` counts every eligible charge a rule matches, so an over-eager rule shows
    up in the preview ("ALDI -> 40 charges" with samples). Those counts can overlap
    where two rules match one charge, so they are a per-rule signal, not a total.
    """
    applicable = []
    skipped_rules = []
    for rule in rules:
        reason = _skip_reason(rule, is_unfiled)
        if reason:
            skipped_rules.append({"id": rule.get("id"), "value": rule.get("value"), "reason": reason})
            continue
        applicable.append(rule)

    eligible = [t for t in transactions if is_unfiled(t.get("category"))]

    matched = []
    conflicted = 0
    conflicted_samples: list[dict] = []
    by_category: dict[str, int] = {}
    rule_hits: dict[int, list[dict]] = {index: [] for index in range(len(applicable))}

    for transaction in eligible:
        resolved, matched_indices, categories = decide(applicable, transaction)
        for index in matched_indices:
            rule_hits[index].append(transaction)
        if not categories:
            continue
        if resolved is None:
            conflicted += 1
            # A bare count is a dead end — the user can't find the charges or see which rules
            # disagreed, and they stay unfiled forever. A few examples make it actionable.
            if len(conflicted_samples) < _SAMPLES_PER_RULE:
                conflicted_samples.append({
                    "description": transaction.get("description"),
                    "categoryIds": sorted(categories),
                })
            continue
        # Carry the winning rule's id so the caller can stamp filed_by_rule (WHIT-536). When
        # rules agree they share the one category, so the first match is the authoritative
        # id — the same choice rule_ingest.file_charge makes on the webhook side.
        rule_id = applicable[matched_indices[0]].get("id")
        matched.append((transaction, resolved, rule_id))
        by_category[resolved] = by_category.get(resolved, 0) + 1

    by_rule = [
        {
            "ruleId": applicable[index].get("id"),
            "value": applicable[index].get("value"),
            "categoryId": applicable[index]["categoryId"],
            "count": len(hits),
            "samples": [hit.get("description") for hit in hits[:_SAMPLES_PER_RULE]],
        }
        for index, hits in rule_hits.items()
        if hits
    ]
    by_rule.sort(key=lambda entry: entry["count"], reverse=True)

    return {
        "unfiled": len(eligible),
        "matched": matched,
        "conflicted": conflicted,
        "conflicted_samples": conflicted_samples,
        "by_category": by_category,
        "by_rule": by_rule,
        "skipped_rules": skipped_rules,
        "rules_considered": len(rules),
    }
