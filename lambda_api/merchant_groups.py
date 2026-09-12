"""Group the charges that still need filing by merchant (WHIT-515).

"Apply my rules" files every charge an existing rule covers. What is left is charges from
merchants the user has never written a rule for, so re-running it can never help. Hand-filing
hundreds of those one at a time is the thing this line of work exists to avoid.

The way out is that N charges is nowhere near N merchants — spending clusters hard. Group the
leftovers by merchant, biggest first, and one decision per merchant clears the tail.

WHIT-519: charges with no merchant name (OSKO transfers, pending card holds) can't form a
merchant group, so a second pass groups the ones whose wording repeats once the trailing
reference number is trimmed ("OSKO PAYMENT 4471123/4/5" -> "OSKO PAYMENT"). Spacing-variant
descriptions stay separate groups on purpose: `contains` does not collapse whitespace, so a
single value can't reach both. Each group carries `groupedBy` ("merchant" or "description") so
the app can label a wording group "charges starting with …" and show samples before filing.

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

import re

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

# A nameless-charge stem must repeat this many times before it becomes a group (WHIT-519). A
# stem seen once is one charge, and grouping a single charge on its description is the very
# "one group per charge" explosion WHIT-515 avoided by skipping nameless rows.
MIN_DESCRIPTION_GROUP_SIZE = 2

# Trailing reference tokens on a nameless charge's description: one or more whitespace-separated
# tokens that carry a digit, anchored to the END. "OSKO PAYMENT 4471123" -> "OSKO PAYMENT";
# "POS AUTH DD *DOORDASH +611800958316AU" -> "POS AUTH DD *DOORDASH". Trailing-only because a
# rule is a single contiguous `contains` value: interior tokens can't be skipped, only the tail
# trimmed. Applied to the ORIGINAL string so interior spacing survives (contains does not
# collapse whitespace — rule_engine.contains).
_TRAILING_REFERENCE = re.compile(r"(?:\s+\S*\d\S*)+$")


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
    with no merchant name is not bucketed here — its merchant identity is unknown. WHIT-519
    picks those up in a second pass (`_bucket_nameless_by_stem`), grouping the ones that share
    stable wording; grouping them on the FULL description would still make a bucket per charge.
    """
    buckets: dict[str, list[dict]] = {}
    for transaction in transactions:
        merchant = _text(transaction.get("merchant_name")).strip()
        if not merchant:
            continue
        buckets.setdefault(merchant.lower(), []).append(transaction)
    return buckets


def _description_stem(description: str) -> str | None:
    """A nameless charge's description with its trailing reference tokens removed, or None if
    what is left is too thin to rule on.

    `OSKO PAYMENT 4471123` -> `OSKO PAYMENT`; `KMART 0421 ONLINE 8812` -> `KMART 0421 ONLINE`
    (only the trailing number goes, an interior one stays). None when the stem has no letter (a
    bare number like `0412` would file every charge carrying that digit run), when it is nothing
    but reference (`DD 1300 655 506` -> `DD`, below the floor), or when it otherwise fails the
    same letters/digits floor merchant patterns use. Sliced from the ORIGINAL string so interior
    spacing is preserved for `contains`.
    """
    stem = _TRAILING_REFERENCE.sub("", description.strip())
    if not any(character.isalpha() for character in stem):
        return None
    if not rule_value_is_safe(stem):
        return None
    return stem


def _bucket_nameless_by_stem(transactions: list[dict]) -> dict[str, list[dict]]:
    """Nameless charges keyed by their folded description stem (WHIT-519).

    Only rows with a usable stem are bucketed; a row whose stem is None (all-numeric, too short)
    stays out and lands in `ungrouped`. Folded on `strip().lower()` — the SAME fold `contains`
    uses, NOT rule_engine.fold, which collapses interior whitespace `contains` would then miss.
    """
    buckets: dict[str, list[dict]] = {}
    for transaction in transactions:
        stem = _description_stem(_text(transaction.get("description")))
        if stem is None:
            continue
        buckets.setdefault(stem.strip().lower(), []).append(transaction)
    return buckets


def _commonest(counts: dict[str, int]) -> str:
    """The most frequent key, breaking ties alphabetically so the same data always wins the
    same value across requests."""
    return min(counts, key=lambda candidate: (-counts[candidate], candidate))


def _rule_value_for_stem_bucket(bucket: list[dict]) -> str | None:
    """The `description contains` value for a stem bucket — the commonest stem spelling — or
    None when the stem does not repeat.

    A stem seen once is one charge; requiring MIN_DESCRIPTION_GROUP_SIZE keeps a lone charge in
    `ungrouped` rather than minting a one-charge rule (the explosion WHIT-515 avoided).
    """
    if len(bucket) < MIN_DESCRIPTION_GROUP_SIZE:
        return None
    counts: dict[str, int] = {}
    for transaction in bucket:
        stem = _description_stem(_text(transaction.get("description")))
        counts[stem] = counts.get(stem, 0) + 1
    return _commonest(counts)


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
    value = _commonest(counts)
    if not rule_value_is_safe(value):
        return None
    return value


def _dates(members: list[dict]) -> tuple[str | None, str | None]:
    dates = sorted(_text(member.get("date")) for member in members if member.get("date"))
    if not dates:
        return None, None
    return dates[0], dates[-1]


def _also_catches(members: list[dict], own_key: str, *, by_stem: bool = False) -> list[dict]:
    """The OTHER merchants this group's rule would sweep in, biggest first.

    A rule on "COLES" also matches "COLES EXPRESS", and filing the group would file her petrol
    as groceries — permanently. Merging the two into one group would hide that; dropping the
    smaller one would lose it. So both groups stay, and each discloses what else its rule
    reaches.

    A member is this group's OWN — not disclosed — when its identity equals `own_key`: for a
    merchant group (`by_stem=False`) that means a NAMED member with this merchant name; for a
    wording group (`by_stem=True`) a NAMELESS member with this stem. Everything else is a sweep
    and is disclosed: named members by merchant name; nameless members that a wording group
    reaches are keyed by THEIR OWN stem (readable — the reference is already trimmed off), so a
    "TRANSFER TO" group visibly names the "TRANSFER TO JOHN" charges it would also file rather
    than hiding them. A nameless member with no stem falls back to the single null-name line —
    for a merchant group that is every nameless sweep ("PAYPAL *COLES ONLINE"), whose per-charge
    references would otherwise become one warning line each.
    """
    counts: dict[str | None, int] = {}
    display: dict[str | None, str | None] = {}
    for member in members:
        merchant = _text(member.get("merchant_name")).strip()
        if merchant:
            key, shown, named = merchant.lower(), merchant, True
        elif by_stem:
            stem = _description_stem(_text(member.get("description")))
            key = stem.strip().lower() if stem is not None else None
            shown, named = stem, False
        else:
            key, shown, named = None, None, False
        # Own identity: a merchant group owns its NAMED matches; a wording group owns its
        # NAMELESS-with-this-stem matches. `named is (not by_stem)` is that "right kind" test.
        if key == own_key and named is (not by_stem):
            continue
        counts[key] = counts.get(key, 0) + 1
        display.setdefault(key, shown)
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
            "groupedBy": "merchant",
            "count": len(members),
            # Scan order, not newest-first: the scan walks account by account, so a group
            # spanning two accounts samples the first account's charges. Illustrative only —
            # firstDate/lastDate cover the whole group.
            "samples": [_text(member.get("description")) for member in members[:_SAMPLES_PER_GROUP]],
            "firstDate": first_date,
            "lastDate": last_date,
            "alsoCatches": _also_catches(members, key),
        })

    # WHIT-519: a second pass over the NAMELESS leftovers (no merchant name, not already swept
    # into a merchant group), grouping the ones whose wording repeats once the trailing
    # reference is trimmed. These are the OSKO / transfer / pending-hold rows that could never
    # form a merchant group. The count is still honest — `contains` over every eligible charge,
    # same as a merchant group — so a wording group discloses any named charge it also reaches.
    nameless_leftovers = [
        transaction for index, transaction in enumerate(eligible)
        if index not in grouped_positions and not _text(transaction.get("merchant_name")).strip()
    ]
    for stem_key, bucket in _bucket_nameless_by_stem(nameless_leftovers).items():
        value = _rule_value_for_stem_bucket(bucket)
        if value is None:
            continue
        positions = [index for index, folded in enumerate(folded_descriptions)
                     if contains(value, folded)]
        members = [eligible[index] for index in positions]
        first_date, last_date = _dates(members)
        grouped_positions.update(positions)
        groups.append({
            "merchant": value,
            "rulePattern": value,
            "groupedBy": "description",
            "count": len(members),
            "samples": [_text(member.get("description")) for member in members[:_SAMPLES_PER_GROUP]],
            "firstDate": first_date,
            "lastDate": last_date,
            "alsoCatches": _also_catches(members, stem_key, by_stem=True),
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
