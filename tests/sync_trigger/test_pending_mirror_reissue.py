"""WHIT-678: the bank re-issues a still-pending charge under a new id when its description text
changes ("Pending - Cettire" → "PENDING - Cettire"). The hourly pending mirror must leave ONE
row per purchase, keeping the user's edit, instead of keeping the edited stale copy forever.

Runs the REAL shared TransactionRepository over the in-memory FakeTable, like
test_pending_mirror.py.
"""

import copy

import pytest

from _pending_mirror_fakes import (
    CETTIRE_NEW,
    CETTIRE_OLD,
    GOGI_NEW,
    GOGI_OLD,
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


def test_a_reissued_pending_takes_the_users_edit_and_the_stale_copy_is_removed(repo, mirror, row):
    repo._table.seed(
        row("old_cettire", CETTIRE_OLD, "-260.36", category="shopping", notes="The North Face Jacket"),
        row("new_cettire", CETTIRE_NEW, "-260.36", category="shopping", filed_by_rule="rule-1"),
        row("old_rush", RUSH_OLD, "-192.00", day="2026-09-29", category="shopping", notes="Patagonia Backpack"),
        row("new_rush", RUSH_NEW, "-192.00", category="shopping", filed_by_rule="rule-1"),
    )

    result = run_mirror(mirror, repo, reissue_bank_rows("new_cettire", "new_rush"), _is_unfiled, REISSUE_TODAY)

    assert stored_ids(repo) == {"new_cettire", "new_rush"}
    cettire = stored(repo, "new_cettire")
    assert cettire["status"] == "pending"
    assert cettire["category"] == "shopping"
    assert cettire["notes"] == "The North Face Jacket"
    assert "filed_by_rule" not in cettire
    rush = stored(repo, "new_rush")
    assert rush["notes"] == "Patagonia Backpack"
    assert "filed_by_rule" not in rush
    assert result["carried"] == 2
    assert result["kept"] == 0
    assert result["failed"] == 0


def test_a_stale_copy_identical_to_the_reissued_pending_is_removed(repo, mirror, row):
    repo._table.seed(
        row("old_myki", MYKI_OLD, "-1.00", category="transport"),
        row("new_myki", MYKI_NEW, "-1.00", category="transport"),
        row("old_gogi", "Pending - Gogi Matcha", "-84.50", category="eatingout"),
        row("new_gogi", "PENDING - Gogi Matcha", "-84.50", category="eatingout"),
    )

    result = run_mirror(mirror, repo, reissue_bank_rows("new_myki", "new_gogi"), _is_unfiled, REISSUE_TODAY)

    assert stored_ids(repo) == {"new_myki", "new_gogi"}
    assert stored(repo, "new_myki")["category"] == "transport"
    assert stored(repo, "new_gogi")["category"] == "eatingout"
    assert result["kept"] == 0
    assert result["failed"] == 0
    assert result["removed"] + result["carried"] == 2


def test_clashing_hand_filed_categories_keep_both_copies(repo, mirror, row):
    repo._table.seed(
        row("old_cettire", CETTIRE_OLD, "-260.36", category="shopping"),
        row("new_cettire", CETTIRE_NEW, "-260.36", category="clothing"),
    )

    result = run_mirror(mirror, repo, reissue_bank_rows("new_cettire"), _is_unfiled, REISSUE_TODAY)

    assert stored_ids(repo) == {"old_cettire", "new_cettire"}
    assert stored(repo, "old_cettire")["category"] == "shopping"
    assert stored(repo, "new_cettire")["category"] == "clothing"
    assert result["kept"] == 1
    assert result["carried"] == 0
    assert result["removed"] == 0


def test_two_possible_replacements_and_no_exact_copy_keep_the_edited_pending(repo, mirror, row):
    repo._table.seed(
        row("old_rush", RUSH_OLD, "-192.00", category="shopping", notes="Patagonia Backpack"),
        row("new_rush_a", RUSH_NEW, "-192.00"),
        row("new_rush_b", RUSH_NEW, "-192.00", day="2026-09-29"),
    )

    result = run_mirror(mirror, repo, reissue_bank_rows("new_rush_a", "new_rush_b"), _is_unfiled, REISSUE_TODAY)

    assert stored_ids(repo) == {"old_rush", "new_rush_a", "new_rush_b"}
    assert "notes" not in stored(repo, "new_rush_a")
    assert "notes" not in stored(repo, "new_rush_b")
    assert result["kept"] == 1
    assert result["carried"] == 0


@pytest.mark.parametrize("new_day, new_amount", [("2026-09-25", "-260.36"), ("2026-09-30", "-260.00")])
def test_a_replacement_too_far_apart_or_for_another_amount_keeps_the_edited_pending(
    repo, mirror, row, new_day, new_amount,
):
    repo._table.seed(
        row("old_cettire", CETTIRE_OLD, "-260.36", day="2026-09-30", category="shopping", notes="Jacket"),
        row("new_cettire", CETTIRE_NEW, new_amount, day=new_day),
    )

    result = run_mirror(mirror, repo, reissue_bank_rows("new_cettire"), _is_unfiled, REISSUE_TODAY)

    assert stored_ids(repo) == {"old_cettire", "new_cettire"}
    assert "notes" not in stored(repo, "new_cettire")
    assert result["kept"] == 1


def test_a_settled_twin_wins_over_a_live_pending_copy(repo, mirror, row):
    repo._table.seed(
        row("old_rush", RUSH_OLD, "-192.00", category="shopping", notes="Patagonia Backpack"),
        row("settled_rush", "SP RUSHFASTERAU SYDNEY AU", "-192.00", status="posted", merchant_name="SP RUSHFASTERAU"),
        row("other_rush", RUSH_NEW, "-192.00"),
    )
    bank = reissue_bank_rows("other_rush") + reissue_bank_rows("settled_rush", pending=False)

    result = run_mirror(mirror, repo, bank, _is_unfiled, REISSUE_TODAY)

    assert stored_ids(repo) == {"settled_rush", "other_rush"}
    settled = stored(repo, "settled_rush")
    assert settled["category"] == "shopping"
    assert settled["notes"] == "Patagonia Backpack"
    other = stored(repo, "other_rush")
    assert other["category"] == "Unfiled"
    assert "notes" not in other
    assert result["carried"] == 1


def test_a_replacement_deleted_mid_run_is_never_resurrected(repo, mirror, row):
    repo._table.seed(
        row("old_cettire", CETTIRE_OLD, "-260.36", category="shopping", notes="The North Face Jacket"),
        row("new_cettire", CETTIRE_NEW, "-260.36", category="shopping", filed_by_rule="rule-1"),
    )

    def delete_replacement():
        del repo._table.store[(f"ACCOUNT#{WESTPAC}", "TXN#new_cettire")]

    result = run_mirror(mirror, repo, reissue_bank_rows("new_cettire"), _is_unfiled, REISSUE_TODAY, before_return=delete_replacement)

    assert stored_ids(repo) == {"old_cettire"}
    assert stored(repo, "old_cettire")["notes"] == "The North Face Jacket"
    assert result["carried"] == 0
    assert result["removed"] == 0


# Two edited stale copies, ONE live re-issue: the second must not overwrite the first's
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


# The live copy settles (webhook flips it to posted) between our read and the carry:
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


# A carry onto a live pending moves tags and the transfer flag too, and recomputes the
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


# A rule-filed charge the user only added a note to (the app's notes-only edit keeps the
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


# Old and new hold the same hand-filed category AND the same note → identical copy,
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


# Same category but clashing notes → both kept (sign-off Q1: no edit is lost).
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


# Re-running the mirror after a successful carry changes nothing (safe to run twice).
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


# WHIT-790:Nothing to carry but a cleared rule stamp sends a valid 'clear only' write.
def test_carry_with_every_field_empty_only_clears_the_rule_stamp(repo, row):
    pending = row("new_cettire", CETTIRE_NEW, "-260.36", category="clothing", notes="Jacket", filed_by_rule="rule-1")
    repo._table.seed(pending)
    carried = {"pk": pending["pk"], "sk": pending["sk"]}

    assert repo.carry_onto_pending(pending["pk"], pending["sk"], carried) is True

    expected = dict(pending)
    expected.pop("filed_by_rule")
    assert stored(repo, "new_cettire") == expected


# Pure rule: a copy filed the same but by a rule is NOT identical to a hand-filed pending
# (and vice versa); the same stamp on both is.
def test_identical_copy_requires_the_same_rule_stamp(pending_carry, row):
    hand = row("old", GOGI_OLD, "-84.50", category="eatingout")
    ruled = row("new", GOGI_NEW, "-84.50", category="eatingout", filed_by_rule="rule-1")
    other_rule = row("new2", GOGI_NEW, "-84.50", category="eatingout", filed_by_rule="rule-2")

    assert pending_carry.find_identical_copy(hand, [ruled]) is None
    assert pending_carry.find_identical_copy(ruled, [hand]) is None
    assert pending_carry.find_identical_copy(ruled, [other_rule]) is None
    assert pending_carry.find_identical_copy(ruled, [hand, ruled | {"transaction_id": "x"}])["transaction_id"] == "x"
