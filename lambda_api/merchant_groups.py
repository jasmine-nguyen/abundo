"""Group the charges that still need filing by merchant (WHIT-515).

"Apply my rules" files every charge an existing rule covers. What is left is charges from
merchants the user has never written a rule for, so re-running it can never help. Hand-filing
hundreds of those one at a time is the thing this line of work exists to avoid.

The way out is that N charges is nowhere near N merchants — spending clusters hard. Group the
leftovers by merchant, biggest first, and one decision per merchant clears the tail.

Pure logic, no I/O: the handler owns the scan, so the grouping can be tested on its own (same
split as the shared rule_engine).

The counts here have to be TRUE, because the next step writes with them. So a group's count is
not "how many rows carry this merchant name" — it is how many eligible charges the rule minted
from this group would actually match, evaluated the same literal way rule_engine.rule_matches
evaluates a `description contains VALUE` rule (both go through rule_engine.contains). That is
what makes "COLES — 50 charges" honest when 12 of them are really COLES EXPRESS, and it is why
every group also reports which OTHER merchants its rule would sweep in (`alsoCatches`).

Unlike plan_rule_application, which returns snake_case internals the handler maps to the wire,
this returns the response body as the app reads it. The shape is all presentation — there is no
second consumer to map it for, and a mapping step would only be somewhere for the two to drift.
"""

# The literal `description contains value` test lives once in the shared rule engine
# (WHIT-527), so a group's count is folded and matched exactly as the minted rule — and
# the webhook — would. This module still folds each description ONCE up front (below).
from rule_engine import contains

# How many example descriptions a group (and the ungrouped bucket) shows.
_SAMPLES_PER_GROUP = 3

# A rule value must carry at least this many letters/digits. Short values are the dangerous
# ones: a rule on "BP" would file every BPAY transfer as petrol, permanently and silently.
# Counted on letters/digits only, so punctuation and spaces can't pad a two-letter value —
# "7-11" is four characters and only three of them count.
MIN_RULE_VALUE_ALPHANUMERICS = 4


def _text(value) -> str:
    return str(value or "")


def _merchant_slice(transaction: dict) -> str | None:
    """Where the merchant name appears inside the description, that slice in the DESCRIPTION's
    own casing — or None when there is no clean slice (no merchant name, or it isn't in the
    description).

    Server twin of the client's merchantSlice (src/context.tsx). Taking the description's
    casing rather than the merchant name's keeps the rule matching whether or not BankSync's
    `contains` is case-sensitive, and dropping everything around the slice sheds the volatile
    store#/location/ref tokens that would otherwise pin the rule to one single charge.
    """
    description = _text(transaction.get("description"))
    merchant = _text(transaction.get("merchant_name")).strip()
    # Belt-and-braces: the only caller buckets by merchant name, so a nameless row never reaches
    # here. Without the guard an empty name would "find" at index 0 and return an empty slice.
    if not merchant:
        return None
    start = description.lower().find(merchant.lower())
    if start < 0:
        return None
    found = description[start:start + len(merchant)]
    # lower() is not always length-preserving ("İ" lowercases to two chars), so an index taken
    # in the lowered description can point into the wrong place in the original. Re-check rather
    # than mint a rule on a slice sliding off the merchant name.
    if found.lower() != merchant.lower():
        return None
    return found


def rule_value_is_safe(value: str) -> bool:
    """Does this `description contains` value carry enough letters/digits to rule on?

    Public because the write half (apply-rules with an inline rule) has to enforce the SAME
    floor this screen offers groups by. Two copies of the number would let the screen offer a
    group the write then refuses.
    """
    return sum(1 for character in value if character.isalnum()) >= MIN_RULE_VALUE_ALPHANUMERICS


def _bucket_by_merchant(transactions: list[dict]) -> dict[str, list[dict]]:
    """Charges keyed by their folded merchant name, preserving input order within each bucket.

    Folded (trim + lowercase) so one merchant's casing variants land in one bucket. A charge
    with no merchant name is not bucketed at all — its merchant identity is unknown, and
    grouping those on the full description would make a bucket per charge.
    """
    buckets: dict[str, list[dict]] = {}
    for transaction in transactions:
        merchant = _text(transaction.get("merchant_name")).strip()
        if not merchant:
            continue
        buckets.setdefault(merchant.lower(), []).append(transaction)
    return buckets


def _rule_value_for_bucket(bucket: list[dict]) -> str | None:
    """The `description contains` value a rule for this bucket would use, or None if the
    bucket can't yield a safe one.

    Derived from the WHOLE bucket, not from one representative row. A single row can fail to
    produce a slice (its description doesn't contain the merchant name), and picking that row
    would collapse a 38-charge group into a rule matching one charge. So: take every slice the
    bucket produces and use the most common one, breaking ties alphabetically so the same data
    always yields the same rule.

    None when no row yields a slice, or when the winning slice is too short to be safe.

    Whatever comes back folds to the bucket's own key (a slice is the merchant name as the
    description spells it), so two buckets can never derive the same value and the caller needs
    no dedup.
    """
    counts: dict[str, int] = {}
    for transaction in bucket:
        slice_ = _merchant_slice(transaction)
        if slice_ is None:
            continue
        counts[slice_] = counts.get(slice_, 0) + 1
    if not counts:
        return None
    value = min(counts, key=lambda candidate: (-counts[candidate], candidate))
    if not rule_value_is_safe(value):
        return None
    return value


def _dates(members: list[dict]) -> tuple[str | None, str | None]:
    dates = sorted(_text(member.get("date")) for member in members if member.get("date"))
    if not dates:
        return None, None
    return dates[0], dates[-1]


def _also_catches(members: list[dict], own_key: str) -> list[dict]:
    """The OTHER merchants this group's rule would sweep in, biggest first.

    A rule on "COLES" also matches "COLES EXPRESS", and filing the group would file her petrol
    as groceries — permanently. Merging the two into one group would hide that; dropping the
    smaller one would lose it. So both groups stay, and each discloses what else its rule
    reaches.

    Members with NO merchant name are disclosed too — "PAYPAL *COLES ONLINE" is swept in just
    the same, and those messy descriptions are the ones this warning exists for. They share one
    entry with a null name, because their descriptions carry a reference number that differs per
    charge: keying them by description would turn 300 swept charges into 300 near-identical
    lines, unreadable in exactly the case that matters. The app supplies the wording.
    """
    counts: dict[str | None, int] = {}
    display: dict[str | None, str | None] = {}
    for member in members:
        merchant = _text(member.get("merchant_name")).strip()
        key = merchant.lower() or None
        if key == own_key:
            continue
        counts[key] = counts.get(key, 0) + 1
        display.setdefault(key, merchant or None)
    return [
        {"merchant": display[key], "count": counts[key]}
        # Biggest first; the unnamed entry sorts as "" among equal counts, so the order is total
        # and stable rather than depending on a None comparison.
        for key in sorted(counts, key=lambda candidate: (-counts[candidate], candidate or ""))
    ]


def group_unfiled_by_merchant(transactions: list[dict], is_unfiled) -> dict:
    """The unfiled charges grouped by merchant, biggest group first.

    `is_unfiled(category)` is the caller's "this charge still needs filing" predicate — the
    same one the badge counts with — so this module never has its own opinion of what
    "uncategorized" means (same contract as rule_engine.plan_rule_application).

    Every group carries the exact `rulePattern` a rule would be minted from, so the app never
    has to guess it and the count it shows is the count that will be filed. Charges no group
    reaches are reported in `ungrouped` rather than silently dropped, so the numbers add up
    against the badge.
    """
    eligible = [t for t in transactions if is_unfiled(t.get("category"))]
    # Folded once, not once per group: every accepted bucket tests its value against every
    # eligible charge, so re-folding here is the whole cost of the walk.
    folded_descriptions = [_text(t.get("description")).strip().lower() for t in eligible]

    groups = []
    grouped_positions: set[int] = set()
    for key, bucket in _bucket_by_merchant(eligible).items():
        value = _rule_value_for_bucket(bucket)
        if value is None:
            continue
        positions = [index for index, folded in enumerate(folded_descriptions)
                     if contains(value, folded)]
        members = [eligible[index] for index in positions]
        first_date, last_date = _dates(members)
        grouped_positions.update(positions)
        groups.append({
            # The heading is the merchant name as first seen; `rulePattern` is the commonest
            # slice, so the two can differ in casing for a merchant spelled inconsistently. The
            # app shows the heading — it is a label, and the pattern is the thing that matters.
            "merchant": _text(bucket[0].get("merchant_name")).strip(),
            "rulePattern": value,
            "count": len(members),
            # Scan order, not newest-first: the scan walks account by account, so a group
            # spanning two accounts samples the first account's charges. Illustrative only —
            # firstDate/lastDate cover the whole group.
            "samples": [_text(member.get("description")) for member in members[:_SAMPLES_PER_GROUP]],
            "firstDate": first_date,
            "lastDate": last_date,
            "alsoCatches": _also_catches(members, key),
        })

    # Biggest first — that is the whole point of the screen. Ties broken on the pattern so the
    # order is stable across requests and a test can assert it.
    groups.sort(key=lambda group: (-group["count"], group["rulePattern"]))

    ungrouped = [t for index, t in enumerate(eligible) if index not in grouped_positions]
    return {
        "unfiled": len(eligible),
        "groups": groups,
        "ungrouped": {
            "count": len(ungrouped),
            "samples": [_text(t.get("description")) for t in ungrouped[:_SAMPLES_PER_GROUP]],
        },
    }
