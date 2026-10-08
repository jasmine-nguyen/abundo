"""WHIT-678 QA fix round: the re-issued-copy rules added by the fix (find_reissued_twin's
"already filed the same" clause, and the identical-copy check now running first). Same fixtures
as test_pending_mirror_reissue_qa.py (the REAL shared repo over FakeTable)."""

from _pending_mirror_fakes import (
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


# [A16] (P1) Old hand-filed + note, re-issue hand-filed the same category with no note → nothing
# clashes, the note moves onto the re-issue and one row remains.
def test_a_note_moves_onto_a_reissue_hand_filed_the_same(repo, mirror, row):
    repo._table.seed(
        row("old_rush", RUSH_OLD, "-192.00", category="shopping", notes="Patagonia Backpack"),
        row("new_rush", RUSH_NEW, "-192.00", category="shopping"),
    )

    result = run_mirror(mirror, repo, reissue_bank_rows("new_rush"), _is_unfiled, REISSUE_TODAY)

    assert stored_ids(repo) == {"new_rush"}
    new = stored(repo, "new_rush")
    assert new["notes"] == "Patagonia Backpack"
    assert new["category"] == "shopping"
    assert result["carried"] == 1


# [A17] (P1) Old rule-filed + note; the rule missed the re-issue (unfiled) → the category, its rule
# stamp and the note all move across.
def test_a_rule_filed_note_moves_onto_an_unfiled_reissue_with_its_stamp(repo, mirror, row):
    repo._table.seed(
        row("old_rush", RUSH_OLD, "-192.00", category="shopping", filed_by_rule="rule-1", notes="Backpack"),
        row("new_rush", RUSH_NEW, "-192.00"),
    )

    result = run_mirror(mirror, repo, reissue_bank_rows("new_rush"), _is_unfiled, REISSUE_TODAY)

    assert stored_ids(repo) == {"new_rush"}
    new = stored(repo, "new_rush")
    assert (new["category"], new["filed_by_rule"], new["notes"]) == ("shopping", "rule-1", "Backpack")
    assert result["carried"] == 1


# [A18] (P1) Old rule-filed + note, TWO live copies filed by the same rule → ambiguous, both kept
# (exactly-one rule), nothing written.
def test_two_rule_filed_reissues_are_ambiguous_and_nothing_moves(repo, mirror, row):
    repo._table.seed(
        row("old_rush", RUSH_OLD, "-192.00", category="shopping", filed_by_rule="rule-1", notes="Backpack"),
        row("new_a", RUSH_NEW, "-192.00", category="shopping", filed_by_rule="rule-1"),
        row("new_b", RUSH_NEW, "-192.00", day="2026-09-29", category="shopping", filed_by_rule="rule-1"),
    )

    result = run_mirror(mirror, repo, reissue_bank_rows("new_a", "new_b"), _is_unfiled, REISSUE_TODAY)

    assert stored_ids(repo) == {"old_rush", "new_a", "new_b"}
    assert "notes" not in stored(repo, "new_a")
    assert "notes" not in stored(repo, "new_b")
    assert result["kept"] == 1


# [A19] (P1) Old rule-filed + note, re-issue filed by a DIFFERENT rule into another category →
# a rule never overrides another rule: kept, re-issue untouched.
def test_a_reissue_filed_by_another_rule_differently_is_left_alone(repo, mirror, row):
    repo._table.seed(
        row("old_rush", RUSH_OLD, "-192.00", category="shopping", filed_by_rule="rule-1", notes="Backpack"),
        row("new_rush", RUSH_NEW, "-192.00", category="clothing", filed_by_rule="rule-2"),
    )

    result = run_mirror(mirror, repo, reissue_bank_rows("new_rush"), _is_unfiled, REISSUE_TODAY)

    assert stored_ids(repo) == {"old_rush", "new_rush"}
    new = stored(repo, "new_rush")
    assert (new["category"], new["filed_by_rule"]) == ("clothing", "rule-2")
    assert "notes" not in new
    assert result["kept"] == 1
