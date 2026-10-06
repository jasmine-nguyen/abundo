"""WHIT-678 QA fix round 2: the rule-stamp clause added to find_identical_copy. Same fixtures as
test_pending_mirror_reissue_qa_fix.py (the REAL shared repo over FakeTable)."""

from _pending_mirror_fakes import (
    GOGI_NEW,
    GOGI_OLD,
    REISSUE_TODAY,
    RUSH_NEW,
    RUSH_OLD,
    reissue_bank_rows,
    run_mirror,
    stored,
    stored_ids,
    unfiled_except,
)

_is_unfiled = unfiled_except("shopping", "clothing", "eatingout", "transport")


# [A20] (P0) Pure rule: a copy filed the same but by a rule is NOT identical to a hand-filed pending
# (and vice versa); the same stamp on both is.
def test_identical_copy_requires_the_same_rule_stamp(pending_carry, row):
    hand = row("old", GOGI_OLD, "-84.50", category="eatingout")
    ruled = row("new", GOGI_NEW, "-84.50", category="eatingout", filed_by_rule="rule-1")
    other_rule = row("new2", GOGI_NEW, "-84.50", category="eatingout", filed_by_rule="rule-2")

    assert pending_carry.find_identical_copy(hand, [ruled]) is None
    assert pending_carry.find_identical_copy(ruled, [hand]) is None
    assert pending_carry.find_identical_copy(ruled, [other_rule]) is None
    assert pending_carry.find_identical_copy(ruled, [hand, ruled | {"transaction_id": "x"}])["transaction_id"] == "x"


# [A21] (P0) Hand-filed + note on the stale copy, rule-filed same category on the re-issue → one row,
# the note moves across and the user owns the category (stamp cleared).
def test_a_noted_hand_filing_clears_the_rule_stamp_on_a_same_category_reissue(repo, mirror, row):
    repo._table.seed(
        row("old_rush", RUSH_OLD, "-192.00", category="shopping", notes="Patagonia Backpack"),
        row("new_rush", RUSH_NEW, "-192.00", category="shopping", filed_by_rule="rule-1"),
    )

    result = run_mirror(mirror, repo, reissue_bank_rows("new_rush"), _is_unfiled, REISSUE_TODAY)

    assert stored_ids(repo) == {"new_rush"}
    new = stored(repo, "new_rush")
    assert (new["category"], new["notes"]) == ("shopping", "Patagonia Backpack")
    assert "filed_by_rule" not in new
    assert result["carried"] == 1


# [A22] (P1) Same rule stamp and same note on both copies → a plain delete, no write; the re-issue
# keeps its rule stamp.
def test_a_copy_with_the_same_rule_stamp_and_note_is_just_removed(repo, mirror, row):
    repo._table.seed(
        row("old_rush", RUSH_OLD, "-192.00", category="shopping", filed_by_rule="rule-1", notes="Backpack"),
        row("new_rush", RUSH_NEW, "-192.00", category="shopping", filed_by_rule="rule-1", notes="Backpack"),
    )

    result = run_mirror(mirror, repo, reissue_bank_rows("new_rush"), _is_unfiled, REISSUE_TODAY)

    assert stored_ids(repo) == {"new_rush"}
    assert stored(repo, "new_rush")["filed_by_rule"] == "rule-1"
    assert (result["removed"], result["carried"]) == (1, 0)
