"""Evaluate the user's categorisation rules against charges ALREADY stored.

BankSync applies rules at SYNC time, to incoming charges only — nothing re-applies
them to charges already in the table (WHIT-502), so rules written today never reach
yesterday's unfiled charges. This module is the "apply my rules to what's already
here" pass. Pure logic, no I/O: the handler owns the scan and the writes, so the
matching can be tested on its own.

Matching is LITERAL — what BankSync itself would do with the same leaf rule — NOT
the fuzzy merchant-similarity gate the client's "every charge from this merchant"
sweep uses. That gate exists so ONE tap on ONE charge can't drag in a look-alike
merchant; here there is no origin charge, and a rule is by definition
"description contains VALUE" / "category equals VALUE".
"""

# Rule fields we can evaluate. `description` is the one the app authors (the client
# only ever mints description/contains — see saveManualRule); `category` equals is a
# raw-enum mapping (e.g. FOOD_AND_DRINK -> groceries) that only exists for rules made
# outside the app, but unfiled rows are exactly the ones carrying raw enums, so it is
# worth honouring when present.
_DESCRIPTION_CONTAINS = ("description", "contains")
_CATEGORY_EQUALS = ("category", "equals")

# How many example descriptions each rule shows in the preview.
_SAMPLES_PER_RULE = 3


def _normalise(value) -> str:
    """Trim + lowercase, both sides of a comparison.

    Deliberately NOT banksync_enrichments._fold, for two reasons. It lives in the BankSync
    HTTP module, and importing it would drag urllib + the SSM key fetch into a module that is
    kept pure and I/O-free. And it also collapses internal whitespace runs, which is the right
    latitude for dedup identity but wider than matching wants: with collapsing, a rule value
    "coles online" would match a description "COLES  ONLINE", quietly matching text the rule
    doesn't literally contain.

    Case-insensitive because descriptions arrive upper-case while users type mixed case, and
    BankSync's own case behaviour is unverified (constants.py) — the preview shows exactly what
    would be filed before anything is written, so erring toward matching is safe here.
    """
    return str(value or "").strip().lower()


def rule_matches(rule: dict, transaction: dict) -> bool:
    """Does this leaf rule match this stored charge? Unknown field/operator -> False
    (the caller reports those rules as skipped rather than silently ignoring them)."""
    target = (rule.get("field"), rule.get("operator"))
    value = _normalise(rule.get("value"))
    if not value:
        return False
    if target == _DESCRIPTION_CONTAINS:
        return value in _normalise(transaction.get("description"))
    if target == _CATEGORY_EQUALS:
        return value == _normalise(transaction.get("category"))
    return False


def _skip_reason(rule: dict, is_unfiled) -> str | None:
    """Why this rule can't be applied, or None if it can.

    A rule whose target category is itself "unfiled" (a deleted category's dangling
    id, or a raw value never in the taxonomy) is load-bearing for safe-to-run-twice:
    filing a charge to it would leave the charge still unfiled, so the next run would
    file it again, forever. Using the SAME predicate the caller uses to pick eligible
    charges makes "filing a charge removes it from the unfiled set" true by
    construction (and correctly accepts `income`, which is filed but not a taxonomy id).
    """
    # We only ever read a rule's FIRST condition, so a foreign multi-condition rule reaches us
    # broadened (see banksync_enrichments._to_rule). Listing that is harmless; filing hundreds of
    # charges on it is not — the narrowing condition we dropped is exactly what kept it in check.
    if rule.get("conditionCount", 1) != 1:
        return "rule has more than one condition"
    if (rule.get("field"), rule.get("operator")) not in (_DESCRIPTION_CONTAINS, _CATEGORY_EQUALS):
        return "unsupported rule type"
    if not _normalise(rule.get("value")):
        return "empty rule value"
    # Distinguished from the next check so the reason doesn't lie: a foreign rule that never had
    # a category at all is a different problem from one whose category was deleted.
    if not rule.get("categoryId"):
        return "rule has no category"
    if is_unfiled(rule["categoryId"]):
        return "category no longer exists"
    return None


def plan_rule_application(rules: list[dict], transactions: list[dict], is_unfiled) -> dict:
    """What applying `rules` to `transactions` would do — decided, not done.

    `is_unfiled(category)` is the caller's "this charge still needs filing" predicate
    (the same one the badge counts with), so this module never has its own opinion of
    what "uncategorized" means.

    A charge matched by rules that DISAGREE on the category is counted in `conflicted`
    and left alone — a conflict must never be silently decided (WHIT-355). Charges
    matched by rules that agree are filed once.

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
        categories = set()
        for index, rule in enumerate(applicable):
            if not rule_matches(rule, transaction):
                continue
            rule_hits[index].append(transaction)
            categories.add(rule["categoryId"])
        if not categories:
            continue
        if len(categories) > 1:
            conflicted += 1
            # A bare count is a dead end — the user can't find the charges or see which rules
            # disagreed, and they stay unfiled forever. A few examples make it actionable.
            if len(conflicted_samples) < _SAMPLES_PER_RULE:
                conflicted_samples.append({
                    "description": transaction.get("description"),
                    "categoryIds": sorted(categories),
                })
            continue
        category_id = categories.pop()
        matched.append((transaction, category_id))
        by_category[category_id] = by_category.get(category_id, 0) + 1

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
