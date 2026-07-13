"""WHIT-275 adversarial GAP test for _with_carried_category (notes/tags carry).

The implementer covers: notes/tags carried onto a bare posted, and an EMPTY note
not carried. This adds the CONFLICT case the decision hinges on: when BOTH the
pending source AND the posted already hold tags (different values), which wins?
The carry guard is `if value:` (truthy source overwrites), so the SOURCE (pending)
tags win — the user's pre-settlement edit is authoritative. Pinned directly on the
static helper so the resolution is explicit, not incidental.
"""


def test_carried_source_tags_overwrite_the_posted_existing_tags(lam, repo):  # [A14]
    posted = {"transaction_id": "B", "category": "FOOD", "tags": ["stale"], "notes": "stale note"}
    source = {"category": "coffee", "tags": ["work", "travel"], "notes": "reimburse"}

    carried = repo._with_carried_category(posted, source)

    # Truthy source value overwrites the posted's own — the pending user edit wins.
    assert carried["tags"] == ["work", "travel"]
    assert carried["notes"] == "reimburse"
    assert carried["category"] == "coffee"
    # And the original posted dict is not mutated (it's a copy).
    assert posted["tags"] == ["stale"]


def test_carried_absent_source_tags_keep_the_posted_existing_tags(lam, repo):  # [A15]
    # The mirror: when the source has NO tags, the posted's own survive (falsy/absent
    # source never clobbers a real value).
    posted = {"transaction_id": "B", "category": "FOOD", "tags": ["keep"]}
    source = {"category": "coffee"}  # no tags/notes

    carried = repo._with_carried_category(posted, source)

    assert carried["tags"] == ["keep"]
    assert carried["category"] == "coffee"
