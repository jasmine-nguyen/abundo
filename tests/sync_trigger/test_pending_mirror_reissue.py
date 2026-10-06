"""WHIT-678: the bank re-issues a still-pending charge under a new id when its description text
changes ("Pending - Cettire" → "PENDING - Cettire"). The hourly pending mirror must leave ONE
row per purchase, keeping the user's edit, instead of keeping the edited stale copy forever.

Runs the REAL shared TransactionRepository over the in-memory FakeTable, like
test_pending_mirror_carry.py.
"""

import pytest

from _pending_mirror_fakes import (
    CETTIRE_NEW,
    CETTIRE_OLD,
    MYKI_NEW,
    MYKI_OLD,
    RUSH_NEW,
    RUSH_OLD,
    WESTPAC,
    reissue_bank_rows,
    run_reissue,
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

    result = run_reissue(mirror, repo, reissue_bank_rows("new_cettire", "new_rush"), _is_unfiled)

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

    result = run_reissue(mirror, repo, reissue_bank_rows("new_myki", "new_gogi"), _is_unfiled)

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

    result = run_reissue(mirror, repo, reissue_bank_rows("new_cettire"), _is_unfiled)

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

    result = run_reissue(mirror, repo, reissue_bank_rows("new_rush_a", "new_rush_b"), _is_unfiled)

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

    result = run_reissue(mirror, repo, reissue_bank_rows("new_cettire"), _is_unfiled)

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

    result = run_reissue(mirror, repo, bank, _is_unfiled)

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

    result = run_reissue(mirror, repo, reissue_bank_rows("new_cettire"), _is_unfiled, before_return=delete_replacement)

    assert stored_ids(repo) == {"old_cettire"}
    assert stored(repo, "old_cettire")["notes"] == "The North Face Jacket"
    assert result["carried"] == 0
    assert result["removed"] == 0
