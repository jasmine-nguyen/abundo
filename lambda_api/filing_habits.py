"""Suggest a rule when the user keeps hand-filing the same shop the same way (WHIT-542).

BankSync files incoming charges by its own hidden memory; ours is visible and user-owned. When
someone has hand-filed a merchant to the SAME category on enough SEPARATE days, offer to mint the
"description contains <merchant>" rule that would do it automatically — the same rule the file-by-shop
screen mints, so accepting a suggestion and filing that shop stay one flow.

Twin of merchant_groups (WHIT-515) pointed at the OPPOSITE dataset: that screen groups the charges
still UNFILED; this one mines the charges the user has FILED BY HAND. "Hand-filed" is
category-in-the-user's-taxonomy (so a raw bank enum, a JSON-null, and a deleted category's dangling
id are all excluded — none is one of the user's own categories) AND no `filed_by_rule` stamp (so a
charge a rule already filed never reads as a hand-filing habit; the stamp is cleared the moment the
user re-files by hand).

Distinct DAYS, not raw count: five charges from one shopping trip filed in one sitting is one habit
signal, not five. The app records no "filed on" timestamp (WHIT-542 decision: on-demand scan, no new
stored state), so the day counted is the charge's own transaction date — "filed the same shop on N
separate spending days", the honest signal the stored data supports.

Pure logic, no I/O — the handler owns the scan, and minting a suggested rule is a separate, explicit
request. The pattern derivation, merchant bucketing, and the alsoCatches disclosure are reused from
merchant_groups so a suggested rule and a merchant-screen rule can never derive or disclose differently.
"""

from merchant_groups import also_catches, bucket_by_merchant, rule_value_for_bucket
from rule_engine import (
    contains,
    existing_at_least_as_specific,
    is_unfiled_category,
    rule_matches,
)

# How many DISTINCT days a merchant must be hand-filed to the SAME category before a rule is
# suggested (WHIT-542). Below this it is a one-off, not a habit, and a nudge on a single filing is
# noise. Local, not a constants.py value — merchant_groups keeps its own floors the same way, and it
# keeps this module constants-free.
MIN_FILING_HABIT_DAYS = 4

# The rule kinds that identify a charge by its WORDING — the ones that name a merchant. A rule keyed
# on amount / direction / account is not a merchant identity, so it never suppresses a suggestion
# (a blanket "direction is debit" rule matches half the account and would otherwise mute everything).
_IDENTITY_FIELDS = {"description", "merchant"}
_IDENTITY_OPERATORS = {"contains", "equals"}


def _text(value) -> str:
    return str(value or "")


def _is_hand_filed(transaction: dict, taxonomy_ids) -> bool:
    """Did the USER file this charge by hand? It carries a merchant name (a nameless charge can't
    form a merchant habit), its category is one of the user's own (a raw bank enum, a null, or a
    deleted category's dangling id is not in the taxonomy), and no rule filed it (`filed_by_rule`
    absent — a rule-filed charge carries the stamp)."""
    return (
        _text(transaction.get("merchant_name")).strip() != ""
        and transaction.get("category") in taxonomy_ids
        and not transaction.get("filed_by_rule")
    )


def _winning_category(bucket: list[dict]) -> tuple[str | None, int]:
    """The category this merchant is hand-filed to on the MOST distinct days, and that day count
    (None, 0 when no charge carries a date).

    A shop filed to two categories yields ONE suggestion — the dominant category — never two cards
    minting the SAME `description contains` rule to different categories (which would collide on the
    shared rule id, `rule_engine.rule_id_for`). Ties break on the category id so the same history
    always wins the same category.
    """
    days_by_category: dict[str, set[str]] = {}
    for transaction in bucket:
        date = _text(transaction.get("date"))
        if not date:
            continue
        days_by_category.setdefault(transaction["category"], set()).add(date)
    if not days_by_category:
        return None, 0
    winner = min(days_by_category, key=lambda category: (-len(days_by_category[category]), category))
    return winner, len(days_by_category[winner])


def _is_identity_rule(rule: dict) -> bool:
    """A single-condition rule that names a charge by its wording (description/merchant,
    contains/equals). A multi-condition rule, or one keyed on amount/direction/account, is not a
    merchant identity — see `_IDENTITY_FIELDS`."""
    if rule.get("conditions"):
        return False
    return rule.get("field") in _IDENTITY_FIELDS and rule.get("operator") in _IDENTITY_OPERATORS


def _already_ruled(rules: list[dict], sample: dict, rule_pattern: str, category_id: str) -> bool:
    """Does an existing rule already handle this merchant, so no suggestion is needed?

    Two ways it does:
      * COVERAGE — a text-identity rule already matches the merchant's charges (`rule_matches` on a
        representative one). Gated to identity rules so a blanket amount/direction rule can't mute
        every suggestion.
      * CLASH — minting `description contains <pattern>` would steamroll a more-specific existing
        rule into a DIFFERENT category (`existing_at_least_as_specific`, the same primitive the
        file-by-shop mint refuses a clash with). A suggestion the mint would reject is a dead end,
        so suppress it here too. A same-category rule is not a clash — it agrees.

    Known limitation: a MULTI-condition rule that already names this merchant (e.g. "merchant
    contains SEDDONS AND amount > 10") does NOT suppress — `_is_identity_rule` rejects it and
    `existing_at_least_as_specific` no-ops on multi-condition rules. This matches the file-by-shop
    mint's own clash check, which has the same multi-condition blind spot, so the two stay
    consistent; fixing it is a cross-cutting change to that shared clash primitive, not this feature.
    """
    for rule in rules:
        if _is_identity_rule(rule) and rule_matches(rule, sample):
            return True
        if (rule.get("categoryId") != category_id
                and existing_at_least_as_specific(rule, "description", "contains", rule_pattern)):
            return True
    return False


def suggest_rules_from_filing_habits(
    transactions: list[dict], rules: list[dict], taxonomy_ids,
    threshold: int = MIN_FILING_HABIT_DAYS,
) -> dict:
    """Rules to suggest from the user's hand-filing habits, most-filed first.

    One suggestion per merchant the user has hand-filed to a single category on >= `threshold`
    distinct days, unless an existing rule already covers it. Each carries the exact
    `description contains` pattern the mint would use (whole-bucket commonest slice, safety-floored,
    from merchant_groups), the winning category, the distinct-day count, and — like the merchant
    screen — `alsoCatches`: the OTHER merchants that pattern would sweep out of the still-UNFILED
    charges, i.e. the forward mis-file risk of accepting the suggestion.
    """
    hand_filed = [t for t in transactions if _is_hand_filed(t, taxonomy_ids)]

    unfiled = [t for t in transactions if is_unfiled_category(t.get("category"), taxonomy_ids)]
    folded_unfiled = [_text(t.get("description")).strip().lower() for t in unfiled]

    suggestions = []
    for merchant_key, bucket in bucket_by_merchant(hand_filed).items():
        category_id, distinct_days = _winning_category(bucket)
        if category_id is None or distinct_days < threshold:
            continue
        rule_pattern = rule_value_for_bucket(bucket)
        if rule_pattern is None:
            continue
        if _already_ruled(rules, bucket[0], rule_pattern, category_id):
            continue
        swept = [unfiled[index] for index, folded in enumerate(folded_unfiled)
                 if contains(rule_pattern, folded)]
        suggestions.append({
            "merchant": _text(bucket[0].get("merchant_name")).strip(),
            "rulePattern": rule_pattern,
            "categoryId": category_id,
            "distinctDays": distinct_days,
            "alsoCatches": also_catches(swept, merchant_key),
        })

    # Most-filed first — the strongest habit is the one worth acting on; ties broken on the pattern
    # so the order is stable across requests and a test can assert it.
    suggestions.sort(key=lambda suggestion: (-suggestion["distinctDays"], suggestion["rulePattern"]))
    return {"suggestions": suggestions}
