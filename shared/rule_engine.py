"""Pure categorisation-rule matching, shared by every path that applies rules.

Rules are applied in more than one place — "Apply my rules" sweeps charges ALREADY
stored (BankSync only applies rules at sync time, to incoming charges — WHIT-502), and
the merchant-grouping preview counts what a minted rule would file. WHIT-526 adds a
third: the webhook, as charges land. The matching logic has to live ONCE so those paths
can never disagree, so it lives here in the shared layer.

Matching is LITERAL — what BankSync itself would do with the same leaf rule — NOT the
fuzzy merchant-similarity gate the client's "every charge from this merchant" sweep uses.
A rule carries a list of conditions ({field, operator, value}) joined by `logic` ('all' = AND,
'any' = OR); a legacy single-condition rule is the degenerate one-condition case and behaves
exactly as before. Supported conditions: description/merchant (contains/equals against the
charge description), category (equals), account (equals), amount (</<=/>/>= against the charge's
magnitude in plain dollars), direction (is_debit/is_credit).

No I/O and NO `from constants import`: this is a flat shared-layer module (the layer is
staged with a non-recursive `cp shared/*.py`, and `lambda_api/constants.py` shadows the
shared constants at runtime — AGENTS.md), so it stays pure and constants-free. Stdlib
`re`, `hashlib`, `decimal` only.
"""

import hashlib
import re
from decimal import Decimal, InvalidOperation

# Every (field, operator) pair the engine can evaluate. This is the ONE source of truth the
# validator's accepted pairs mirror (lambda_api/constants.py) — the engine and constants do not
# import each other, so a parity test guards the drift (edit BOTH together). `description` is the
# field the app authors (the client mints description/contains — see saveManualRule); `merchant`
# matches the SAME charge description (a friendlier label, not a separate field); `category` equals
# is a raw-enum mapping honoured for rules made outside the app.
SUPPORTED_CONDITIONS = frozenset({
    ("description", "contains"),
    ("merchant", "contains"),
    ("merchant", "equals"),
    ("category", "equals"),
    ("account", "equals"),
    ("amount", "<"),
    ("amount", "<="),
    ("amount", ">"),
    ("amount", ">="),
    ("direction", "is_debit"),
    ("direction", "is_credit"),
})

# Conditions whose `value` is meaningful; `direction` carries its meaning in the operator alone.
_VALUELESS_FIELDS = frozenset({"direction"})

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


def _canonical_value(field: str, value) -> str:
    """The value as it enters the rule id — canonicalised so two rules that MATCH identically
    also share an id (the id is the dedup key). Each field folds the way it matches:
    - amount: the numeric value, so `50` and `50.0` collapse (matching compares magnitudes).
    - account: trimmed but case-preserving (account ids are opaque codes, matched exactly).
    - direction: no value (the operator carries the meaning).
    - description/merchant/category: `fold` (case + internal whitespace), as matching normalises.
    """
    if field == "amount":
        amount = _to_decimal(value)
        return "" if amount is None else format(amount.normalize(), "f")
    if field == "account":
        return str(value or "").strip()
    if field in _VALUELESS_FIELDS:
        return ""
    return fold(value)


def _condition_id_part(condition: dict) -> str:
    """One condition's contribution to the rule id: "field|operator|canonical value"."""
    field = condition.get("field")
    return f"{field}|{condition.get('operator')}|{_canonical_value(field, condition.get('value'))}"


def rule_id_for(field: str | None = None, operator: str | None = None, value=None, *,
                conditions: list[dict] | None = None, logic: str = "all") -> str:
    """Stable dedup id for a rule: the first 16 hex chars of a sha256 digest. The id IS the
    duplicate guard — our rule store keys a row on it, so "the same rule twice" lands on the same
    row by construction (WHIT-528).

    A single-condition rule (whether passed as field/operator/value or a one-element `conditions`)
    hashes EXACTLY "field|operator|canonical value" — byte-for-byte the pre-WHIT-561 recipe for
    description/category rules, so existing rows keep their id with no migration. A multi-condition
    rule hashes each condition, sorts the per-condition digests (order-independent: A AND B == B AND
    A), and combines them under `logic` (so 'all' and 'any' are different rules, as they file
    different charges).
    """
    if conditions is None:
        conditions = [{"field": field, "operator": operator, "value": value}]
    if len(conditions) == 1:
        digest = hashlib.sha256(_condition_id_part(conditions[0]).encode("utf-8")).hexdigest()
        return digest[:16]
    part_digests = sorted(
        hashlib.sha256(_condition_id_part(condition).encode("utf-8")).hexdigest()
        for condition in conditions
    )
    combined = f"{logic}|" + "|".join(part_digests)
    return hashlib.sha256(combined.encode("utf-8")).hexdigest()[:16]


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


def _to_decimal(value):
    """Coerce a rule value or charge amount to Decimal, or None if it isn't a number."""
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return None


_AMOUNT_COMPARATORS = {
    "<": lambda magnitude, limit: magnitude < limit,
    "<=": lambda magnitude, limit: magnitude <= limit,
    ">": lambda magnitude, limit: magnitude > limit,
    ">=": lambda magnitude, limit: magnitude >= limit,
}


def _condition_matches(condition: dict, transaction: dict) -> bool:
    """Does one condition hold for this charge? Unknown (field, operator) -> False."""
    field = condition.get("field")
    operator = condition.get("operator")
    if (field, operator) not in SUPPORTED_CONDITIONS:
        return False

    if field in ("description", "merchant"):
        value = _normalise(condition.get("value"))
        if not value:
            return False
        description = _normalise(transaction.get("description"))
        if operator == "contains":
            return contains(value, description)
        return value == description

    if field == "category":
        value = _normalise(condition.get("value"))
        return bool(value) and value == _normalise(transaction.get("category"))

    if field == "account":
        value = str(condition.get("value") or "").strip()
        return bool(value) and value == str(transaction.get("account_id") or "").strip()

    if field == "amount":
        limit = _to_decimal(condition.get("value"))
        charge = _to_decimal(transaction.get("amount"))
        if limit is None or charge is None:
            return False
        return _AMOUNT_COMPARATORS[operator](abs(charge), limit)

    # direction: the charge's sign — spend is stored negative, income positive (shared/spend.py).
    charge = _to_decimal(transaction.get("amount"))
    if charge is None:
        return False
    return charge < 0 if operator == "is_debit" else charge >= 0


def _conditions_of(rule: dict) -> list[dict]:
    """The rule's condition list — its own `conditions`, or a single condition synthesised from
    the legacy flat `field/operator/value` so old rules read the same as new ones."""
    conditions = rule.get("conditions")
    if conditions:
        return conditions
    return [{"field": rule.get("field"), "operator": rule.get("operator"), "value": rule.get("value")}]


def rule_matches(rule: dict, transaction: dict) -> bool:
    """Does this rule match this stored charge? A rule matches when its conditions hold under its
    `logic` ('all' = every condition, 'any' = at least one). A single-condition rule is the
    degenerate case and behaves exactly as the pre-WHIT-561 leaf matcher did. Unknown
    field/operator in a condition -> that condition is False (the caller reports wholly
    unsupported rules as skipped rather than silently ignoring them)."""
    conditions = _conditions_of(rule)
    if rule.get("logic") == "any":
        return any(_condition_matches(condition, transaction) for condition in conditions)
    return all(_condition_matches(condition, transaction) for condition in conditions)


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
    conditions = _conditions_of(rule)
    for condition in conditions:
        field = condition.get("field")
        if (field, condition.get("operator")) not in SUPPORTED_CONDITIONS:
            return "unsupported rule type"
        if field == "amount":
            if _to_decimal(condition.get("value")) is None:
                return "empty rule value"
        elif field not in _VALUELESS_FIELDS and not _normalise(condition.get("value")):
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
    # "More specific wins" compares a single (field, operator, value) per rule. A multi-condition
    # rule has no single triple to reason over, so a disagreement involving one can't be resolved
    # that way — it stays conflicted (WHIT-561: multi-condition clash handling is runtime-only).
    # The charge is left unfiled, never mis-filed.
    if any(len(_conditions_of(rule)) > 1 for rule in matched_rules):
        return None, matched_indices, categories

    single_conditions = [_conditions_of(rule)[0] for rule in matched_rules]
    folded_values = [fold(condition.get("value")) for condition in single_conditions]
    targets = [(condition.get("field"), condition.get("operator")) for condition in single_conditions]
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
