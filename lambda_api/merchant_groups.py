"""Group the charges that still need filing by merchant (WHIT-515).

"Apply my rules" files every charge an existing rule covers. What is left is charges from
merchants the user has never written a rule for, so re-running it can never help. Hand-filing
hundreds of those one at a time is the thing this line of work exists to avoid.

The way out is that N charges is nowhere near N merchants — spending clusters hard. Group the
leftovers by merchant, biggest first, and one decision per merchant clears the tail.

Pure logic, no I/O: the handler owns the scan, so the grouping can be tested on its own (same
split as rule_apply.py).

The counts here have to be TRUE, because the next step writes with them. So a group's count is
not "how many rows carry this merchant name" — it is how many eligible charges the rule minted
from this group would actually match, evaluated the same literal way rule_apply.rule_matches
evaluates a `description contains VALUE` rule. That is what makes "COLES — 50 charges" honest
when 12 of them are really COLES EXPRESS, and it is why every group also reports which OTHER
merchants its rule would sweep in (`alsoCatches`).
"""

# How many example descriptions a group (and the ungrouped bucket) shows.
_SAMPLES_PER_GROUP = 3

# A rule value must carry at least this many letters/digits. Short values are the dangerous
# ones: a rule on "BP" would file every BPAY transfer as petrol, permanently and silently.
# Counted on letters/digits only, so punctuation and spaces can't pad a two-letter value.
_MIN_RULE_VALUE_ALPHANUMERICS = 4


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
    if not merchant:
        return None
    start = description.lower().find(merchant.lower())
    if start < 0:
        return None
    return description[start:start + len(merchant)]


def _alphanumeric_length(value: str) -> int:
    return sum(1 for character in value if character.isalnum())


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
    if _alphanumeric_length(value) < _MIN_RULE_VALUE_ALPHANUMERICS:
        return None
    return value


def _matches(transaction: dict, value: str) -> bool:
    """The same literal `description contains value` test rule_apply.rule_matches applies, so
    a group's count equals what the minted rule would really file. Case-insensitive for the
    same reason it is there: descriptions arrive upper-case and BankSync's own case behaviour
    is unverified."""
    return value.lower() in _text(transaction.get("description")).lower()


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
    """
    counts: dict[str, int] = {}
    display: dict[str, str] = {}
    for member in members:
        merchant = _text(member.get("merchant_name")).strip()
        key = merchant.lower()
        if not merchant or key == own_key:
            continue
        counts[key] = counts.get(key, 0) + 1
        display.setdefault(key, merchant)
    return [
        {"merchant": display[key], "count": counts[key]}
        for key in sorted(counts, key=lambda candidate: (-counts[candidate], candidate))
    ]


def group_unfiled_by_merchant(transactions: list[dict], is_unfiled) -> dict:
    """The unfiled charges grouped by merchant, biggest group first.

    `is_unfiled(category)` is the caller's "this charge still needs filing" predicate — the
    same one the badge counts with — so this module never has its own opinion of what
    "uncategorized" means (same contract as rule_apply.plan_rule_application).

    Every group carries the exact `rulePattern` a rule would be minted from, so the app never
    has to guess it and the count it shows is the count that will be filed. Charges no group
    reaches are reported in `ungrouped` rather than silently dropped, so the numbers add up
    against the badge.
    """
    eligible = [t for t in transactions if is_unfiled(t.get("category"))]

    groups = []
    grouped_positions: set[int] = set()
    seen_values: set[str] = set()
    for key, bucket in _bucket_by_merchant(eligible).items():
        value = _rule_value_for_bucket(bucket)
        if value is None:
            continue
        # Two buckets deriving the same value would render as two identical rows offering the
        # same rule. Keep the first (buckets are walked in first-seen order).
        if value.lower() in seen_values:
            continue
        seen_values.add(value.lower())
        positions = [index for index, t in enumerate(eligible) if _matches(t, value)]
        members = [eligible[index] for index in positions]
        first_date, last_date = _dates(members)
        grouped_positions.update(positions)
        groups.append({
            "merchant": _text(bucket[0].get("merchant_name")).strip(),
            "rulePattern": value,
            "count": len(members),
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
