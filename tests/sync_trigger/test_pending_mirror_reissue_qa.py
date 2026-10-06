"""WHIT-678 QA: adversarial edges of the hourly mirror's carry onto the bank's re-issued pending
copy. Same fixtures as test_pending_mirror_reissue.py (the REAL shared repo over FakeTable)."""

import copy

from _pending_mirror_fakes import (
    CETTIRE_NEW,
    CETTIRE_OLD,
    MYKI_NEW,
    MYKI_OLD,
    REISSUE_TODAY,
    RUSH_NEW,
    RUSH_OLD,
    WESTPAC,
    reissue_bank_rows,
    run_mirror,
    stored,
    stored_ids,
    unfiled_except,
)

_is_unfiled = unfiled_except("shopping", "clothing", "eatingout", "transport")


# [A1] (P0) Two edited stale copies, ONE live re-issue: the second must not overwrite the first's
# carried edit (the live pool is trimmed after a claim).
def test_one_live_copy_takes_only_one_edit_when_two_stale_copies_compete(repo, mirror, row):
    repo._table.seed(
        row("old_a", RUSH_OLD, "-192.00", notes="Backpack"),
        row("old_b", RUSH_OLD, "-192.00", day="2026-09-29", notes="Gift"),
        row("new_rush", RUSH_NEW, "-192.00"),
    )

    result = run_mirror(mirror, repo, reissue_bank_rows("new_rush"), _is_unfiled, REISSUE_TODAY)

    assert result["carried"] == 1
    assert result["kept"] == 1
    survivors = stored_ids(repo)
    assert "new_rush" in survivors
    assert len(survivors) == 2
    kept_old = (survivors - {"new_rush"}).pop()
    assert stored(repo, "new_rush")["notes"] != stored(repo, kept_old)["notes"]


# [A2] (P0) The live copy settles (webhook flips it to posted) between our read and the carry:
# the conditional write refuses, the posted row is untouched and the old pending kept.
def test_a_replacement_that_posts_mid_run_is_not_overwritten(repo, mirror, row):
    repo._table.seed(
        row("old_cettire", CETTIRE_OLD, "-260.36", category="shopping", notes="Jacket"),
        row("new_cettire", CETTIRE_NEW, "-260.36", category="clothing", filed_by_rule="rule-1"),
    )

    def settle(key, table):
        stored = table.store.get((f"ACCOUNT#{WESTPAC}", "TXN#new_cettire"))
        if stored is not None:
            stored["status"] = "posted"
    repo._table.before_next_write(settle)

    result = run_mirror(mirror, repo, reissue_bank_rows("new_cettire"), _is_unfiled, REISSUE_TODAY)

    assert stored_ids(repo) == {"old_cettire", "new_cettire"}
    posted = stored(repo, "new_cettire")
    assert posted["category"] == "clothing"
    assert posted["filed_by_rule"] == "rule-1"
    assert "notes" not in posted
    assert result["gone"] == 1
    assert result["carried"] == 0


# [A3] (P0) A carry onto a live pending moves tags and the transfer flag too, and recomputes the
# budget flag from the landed category.
def test_carry_onto_a_live_copy_moves_tags_exclusion_and_budget_flag(repo, mirror, row):
    repo._table.seed(
        row("old_cettire", CETTIRE_OLD, "-260.36", category="shopping",
            tags=["gift"], budget_excluded=True, notes="Jacket"),
        row("new_cettire", CETTIRE_NEW, "-260.36", counts_to_budget=False),
    )

    result = run_mirror(mirror, repo, reissue_bank_rows("new_cettire"), _is_unfiled, REISSUE_TODAY)

    assert stored_ids(repo) == {"new_cettire"}
    new = stored(repo, "new_cettire")
    assert new["category"] == "shopping"
    assert new["tags"] == ["gift"]
    assert new["budget_excluded"] is True
    assert new["notes"] == "Jacket"
    assert new["counts_to_budget"] is True
    assert new["status"] == "pending"
    assert result["carried"] == 1


# [A4] (P0) A rule-filed charge the user only added a note to (the app's notes-only edit keeps the
# rule stamp) is re-issued and the same rule files the copy. Nothing clashes, so ONE row must
# remain with the note. Today both are kept forever → the purchase counts twice.
def test_a_rule_filed_pending_with_a_note_is_merged_into_its_rule_filed_reissue(repo, mirror, row):
    repo._table.seed(
        row("old_rush", RUSH_OLD, "-192.00", category="shopping", filed_by_rule="rule-1",
            notes="Patagonia Backpack"),
        row("new_rush", RUSH_NEW, "-192.00", category="shopping", filed_by_rule="rule-1"),
    )

    result = run_mirror(mirror, repo, reissue_bank_rows("new_rush"), _is_unfiled, REISSUE_TODAY)

    assert stored_ids(repo) == {"new_rush"}
    assert stored(repo, "new_rush")["notes"] == "Patagonia Backpack"
    assert result["kept"] == 0


# [A5] (P1) Old and new hold the same hand-filed category AND the same note → identical copy,
# the stale one is just deleted (counted as removed, nothing written to the copy).
def test_identical_copy_with_the_same_note_is_removed_without_a_write(repo, mirror, row):
    repo._table.seed(
        row("old_rush", RUSH_OLD, "-192.00", category="shopping", notes="Backpack"),
        row("new_rush", RUSH_NEW, "-192.00", category="shopping", notes="Backpack"),
    )

    result = run_mirror(mirror, repo, reissue_bank_rows("new_rush"), _is_unfiled, REISSUE_TODAY)

    assert stored_ids(repo) == {"new_rush"}
    assert result["removed"] == 1
    assert result["carried"] == 0
    assert repo._table.update_calls == []


# [A6] (P1) Same category but clashing notes → both kept (sign-off Q1: no edit is lost).
def test_same_category_but_clashing_notes_keeps_both(repo, mirror, row):
    repo._table.seed(
        row("old_rush", RUSH_OLD, "-192.00", category="shopping", notes="Backpack"),
        row("new_rush", RUSH_NEW, "-192.00", category="shopping", notes="Gift"),
    )

    result = run_mirror(mirror, repo, reissue_bank_rows("new_rush"), _is_unfiled, REISSUE_TODAY)

    assert stored_ids(repo) == {"old_rush", "new_rush"}
    assert stored(repo, "new_rush")["notes"] == "Gift"
    assert result["kept"] == 1
    assert result["removed"] == 0


# [A7] (P1) A live copy that already holds a DIFFERENT note (WHIT-666 guard) never gets overwritten,
# even when it's unfiled.
def test_an_unfiled_live_copy_with_its_own_note_is_never_overwritten(repo, mirror, row):
    repo._table.seed(
        row("old_rush", RUSH_OLD, "-192.00", category="shopping", notes="Backpack"),
        row("new_rush", RUSH_NEW, "-192.00", notes="Gift"),
    )

    result = run_mirror(mirror, repo, reissue_bank_rows("new_rush"), _is_unfiled, REISSUE_TODAY)

    assert stored_ids(repo) == {"old_rush", "new_rush"}
    assert stored(repo, "new_rush")["notes"] == "Gift"
    assert result["kept"] == 1


# [A8] (P1) A different shop with the same amount and day is never a copy.
def test_a_different_shop_for_the_same_amount_is_not_a_copy(repo, mirror, row):
    repo._table.seed(
        row("old_rush", RUSH_OLD, "-192.00", category="shopping", notes="Backpack"),
        row("other_shop", "PENDING - Cettire", "-192.00", category="shopping", notes="Backpack"),
    )

    result = run_mirror(mirror, repo, reissue_bank_rows("other_shop"), _is_unfiled, REISSUE_TODAY)

    assert stored_ids(repo) == {"old_rush", "other_shop"}
    assert result["kept"] == 1


# [A9] (P1) Carry write fails (throttle) → nothing deleted, counted failed, old kept for next hour.
def test_a_failed_carry_write_keeps_the_stale_copy(repo, mirror, row):
    repo._table.seed(
        row("old_rush", RUSH_OLD, "-192.00", category="shopping", notes="Backpack"),
        row("new_rush", RUSH_NEW, "-192.00"),
    )
    repo._table.fail("update_item")

    result = run_mirror(mirror, repo, reissue_bank_rows("new_rush"), _is_unfiled, REISSUE_TODAY)

    assert stored_ids(repo) == {"old_rush", "new_rush"}
    assert "notes" not in stored(repo, "new_rush")
    assert result["failed"] == 1
    assert result["carried"] == 0


# [A10] (P1) Delete of the stale copy fails after an identical match → counted failed, no crash.
def test_a_failed_delete_of_an_identical_copy_is_counted_failed(repo, mirror, row):
    repo._table.seed(
        row("old_myki", MYKI_OLD, "-1.00", category="transport"),
        row("new_myki", MYKI_NEW, "-1.00", category="transport"),
    )
    repo._table.fail("delete_item")

    result = run_mirror(mirror, repo, reissue_bank_rows("new_myki"), _is_unfiled, REISSUE_TODAY)

    assert stored_ids(repo) == {"old_myki", "new_myki"}
    assert result["failed"] == 1
    assert result["removed"] == 0


# [A11] (P1) Re-running the mirror after a successful carry changes nothing (safe to run twice).
def test_a_second_run_after_the_carry_changes_nothing(repo, mirror, row):
    repo._table.seed(
        row("old_cettire", CETTIRE_OLD, "-260.36", category="shopping", notes="Jacket"),
        row("new_cettire", CETTIRE_NEW, "-260.36", category="shopping", filed_by_rule="rule-1"),
    )
    run_mirror(mirror, repo, reissue_bank_rows("new_cettire"), _is_unfiled, REISSUE_TODAY)
    after_first = copy.deepcopy(repo._table.store)

    result = run_mirror(mirror, repo, reissue_bank_rows("new_cettire"), _is_unfiled, REISSUE_TODAY)

    assert repo._table.store == after_first
    assert result["carried"] == 0
    assert result["removed"] == 0


# [A12] (P0) Two genuine identical pendings (two $1 myki taps) BOTH still listed are untouched.
def test_two_genuine_identical_pendings_both_listed_are_untouched(repo, mirror, row):
    repo._table.seed(
        row("tap_1", MYKI_NEW, "-1.00", category="transport"),
        row("tap_2", MYKI_NEW, "-1.00", category="transport"),
    )

    result = run_mirror(mirror, repo, reissue_bank_rows("tap_1", "tap_2"), _is_unfiled, REISSUE_TODAY)

    assert stored_ids(repo) == {"tap_1", "tap_2"}
    assert result["removed"] == 0
    assert result["carried"] == 0


# [A13] (P1) carry_onto_pending never creates a row that is gone.
def test_carry_onto_pending_never_creates_a_missing_row(repo, row):
    carried = row("ghost", CETTIRE_NEW, "-260.36", category="shopping", notes="Jacket")

    assert repo.carry_onto_pending(carried["pk"], carried["sk"], carried) is False
    assert stored_ids(repo) == set()


# [A14] (P1) carry_onto_pending refuses a row that has posted and leaves it unchanged.
def test_carry_onto_pending_refuses_a_posted_row(repo, row):
    posted = row("settled", CETTIRE_NEW, "-260.36", status="posted", category="clothing", filed_by_rule="rule-1")
    repo._table.seed(posted)
    carried = dict(posted, category="shopping", notes="Jacket")
    carried.pop("filed_by_rule")

    assert repo.carry_onto_pending(posted["pk"], posted["sk"], carried) is False
    assert stored(repo, "settled") == posted
