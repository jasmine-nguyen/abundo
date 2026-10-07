"""WHIT-663 QA: adversarial edges of the hourly mirror carrying a user's edit onto the settled twin.

Runs the REAL shared TransactionRepository and pending_carry over the in-memory FakeTable, like
test_pending_mirror.py.
"""

import logging
from decimal import Decimal

import pytest

from _budget_endpoint_fakes import _FakeCategoryRepo
from _pending_mirror_fakes import (
    GUZMAN,
    MIRROR_TODAY,
    UP,
    WESTPAC,
    bank_rows,
    pending_row,
    run_mirror,
    stored,
    stored_ids,
    unfiled_except,
)


def _run(mirror, repo, is_unfiled=None):
    return run_mirror(mirror, repo, bank_rows("kept"), is_unfiled or unfiled_except("income", "groceries", "dining"))


# --- each kind of edit carries -------------------------------------------------------------------


@pytest.mark.parametrize("edit", [
    {"notes": "dinner with Sam"},
    {"tags": ["trip"]},
    {"budget_excluded": True},
    {"category": "groceries"},
])
def test_each_kind_of_user_edit_is_carried_and_the_pending_removed(repo, mirror, edit):
    # [A1] Card: "own category, note, tags, budget exclusion" — each alone moves to the twin.
    repo._table.seed(pending_row("kept"), pending_row("edited", **edit, **GUZMAN), pending_row("settled", status="posted", **GUZMAN))

    result = _run(mirror, repo)

    assert stored_ids(repo) == {"kept", "settled"}
    for field_name, value in edit.items():
        assert stored(repo, "settled")[field_name] == value
    assert result["carried"] == 1
    assert result["kept"] == 0
    assert result["failed"] == 0


def test_the_carry_keeps_the_settled_charges_own_fields(repo, mirror):
    # [A2] The carry rewrites the whole twin row: fields only the settled charge has must survive.
    repo._table.seed(
        pending_row("kept"),
        pending_row("edited", notes="dinner with Sam", **GUZMAN),
        pending_row("settled", status="posted", day="2026-09-29", posted_at="2026-09-29T10:00:00Z",
             description="GUZMAN Y GOMEZ NEWTOWN AU", amount=GUZMAN["amount"], merchant_name="Guzman y Gomez"),
    )

    _run(mirror, repo)

    settled = stored(repo, "settled")
    assert settled["status"] == "posted"
    assert settled["date"] == "2026-09-29"
    assert settled["posted_at"] == "2026-09-29T10:00:00Z"
    assert settled["description"] == "GUZMAN Y GOMEZ NEWTOWN AU"
    assert settled["notes"] == "dinner with Sam"


def test_a_raw_bank_category_on_the_pending_does_not_overwrite_the_twins(repo, mirror):
    # [A3] Only the note is the user's edit; the pending's raw bank category is not carried.
    repo._table.seed(
        pending_row("kept"),
        pending_row("edited", category="FOOD_AND_DRINK", notes="dinner with Sam", **GUZMAN),
        pending_row("settled", status="posted", category="RESTAURANTS", **GUZMAN),
    )

    result = _run(mirror, repo)

    assert stored(repo, "settled")["category"] == "RESTAURANTS"
    assert stored(repo, "settled")["notes"] == "dinner with Sam"
    assert result["carried"] == 1


def test_the_carried_twin_budget_flag_follows_the_carried_category(repo, mirror):
    # [A4] A user filing the pending as a transfer → the settled charge stops counting to budget.
    repo._table.seed(
        pending_row("kept"),
        pending_row("edited", category="TRANSFER_OUT", **GUZMAN),
        pending_row("settled", status="posted", counts_to_budget=True, **GUZMAN),
    )

    _run(mirror, repo, unfiled_except("income", "TRANSFER_OUT"))

    assert stored(repo, "settled")["category"] == "TRANSFER_OUT"
    assert stored(repo, "settled")["counts_to_budget"] is False


# --- rule-filed twins and pendings ---------------------------------------------------------------


def test_a_users_own_category_overrides_a_rule_filed_twin_and_drops_the_rule_stamp(repo, mirror):
    # [A5] A user override beats a rule's guess (WHIT-553); the stamp moves with the category.
    repo._table.seed(
        pending_row("kept"),
        pending_row("edited", category="groceries", **GUZMAN),
        pending_row("settled", status="posted", category="dining", filed_by_rule="rule-1", **GUZMAN),
    )

    result = _run(mirror, repo)

    assert stored(repo, "settled")["category"] == "groceries"
    assert "filed_by_rule" not in stored(repo, "settled")
    assert "edited" not in stored_ids(repo)
    assert result["carried"] == 1


def test_a_noted_pending_never_overrides_a_rule_filed_twin(repo, mirror):
    # [A6] Notes-only pending → only an UNFILED twin is eligible; kept for the age-out instead.
    repo._table.seed(
        pending_row("kept"),
        pending_row("edited", notes="dinner with Sam", **GUZMAN),
        pending_row("settled", status="posted", category="dining", filed_by_rule="rule-1", **GUZMAN),
    )

    result = _run(mirror, repo)

    assert "edited" in stored_ids(repo)
    assert "notes" not in stored(repo, "settled")
    assert stored(repo, "settled")["filed_by_rule"] == "rule-1"
    assert result["kept"] == 1
    assert result["carried"] == 0


def test_a_rule_filed_noted_pending_carries_its_rule_and_note_onto_an_unfiled_twin(repo, mirror):
    # [A7] The rule category and its stamp travel together with the user's note.
    repo._table.seed(
        pending_row("kept"),
        pending_row("edited", category="groceries", filed_by_rule="rule-1", notes="dinner with Sam", **GUZMAN),
        pending_row("settled", status="posted", **GUZMAN),
    )

    result = _run(mirror, repo)

    settled = stored(repo, "settled")
    assert (settled["category"], settled["filed_by_rule"], settled["notes"]) == ("groceries", "rule-1", "dinner with Sam")
    assert result["carried"] == 1


def test_a_rule_filed_pending_with_no_user_edit_is_removed_not_carried(repo, mirror):
    # [A8] Regression: a rule's category alone isn't a user edit → deleted as before, twin untouched.
    repo._table.seed(
        pending_row("kept"),
        pending_row("ruled", category="groceries", filed_by_rule="rule-1", **GUZMAN),
        pending_row("settled", status="posted", **GUZMAN),
    )

    result = _run(mirror, repo)

    assert stored_ids(repo) == {"kept", "settled"}
    assert stored(repo, "settled")["category"] == "Unfiled"
    assert result["removed"] == 1
    assert result["carried"] == 0


# --- strict matching -----------------------------------------------------------------------------


def test_two_equally_good_twins_carry_nothing(repo, mirror):
    # [A9] A tie is ambiguous → keep the pending, touch neither twin.
    repo._table.seed(
        pending_row("kept"),
        pending_row("edited", notes="dinner with Sam", **GUZMAN),
        pending_row("settled_a", status="posted", **GUZMAN),
        pending_row("settled_b", status="posted", **GUZMAN),
    )

    result = _run(mirror, repo)

    assert "edited" in stored_ids(repo)
    assert "notes" not in stored(repo, "settled_a")
    assert "notes" not in stored(repo, "settled_b")
    assert result["kept"] == 1


def test_a_one_cent_amount_difference_is_not_a_twin(repo, mirror):
    # [A10] Exact amount only.
    repo._table.seed(
        pending_row("kept"),
        pending_row("edited", notes="dinner with Sam", **GUZMAN),
        pending_row("settled", status="posted", **{**GUZMAN, "amount": Decimal("-23.51")}),
    )

    result = _run(mirror, repo)

    assert "edited" in stored_ids(repo)
    assert "notes" not in stored(repo, "settled")
    assert result["kept"] == 1


def test_a_different_shop_is_not_a_twin(repo, mirror):
    # [A11] Same amount and day, other merchant → no carry.
    repo._table.seed(
        pending_row("kept"),
        pending_row("edited", notes="dinner with Sam", **GUZMAN),
        pending_row("settled", status="posted", amount=GUZMAN["amount"], merchant_name="Coles", description="COLES 1234"),
    )

    result = _run(mirror, repo)

    assert "edited" in stored_ids(repo)
    assert result["kept"] == 1


def test_a_twin_exactly_three_days_before_the_check_window_is_found(repo, mirror):
    # [A12] Read boundary: pending on the first checked day (22 Sep), twin on 19 Sep.
    repo._table.seed(
        pending_row("kept"),
        pending_row("edited", day="2026-09-22", notes="dinner with Sam", **GUZMAN),
        pending_row("settled", status="posted", day="2026-09-19", **GUZMAN),
    )

    result = _run(mirror, repo)

    assert stored_ids(repo) == {"kept", "settled"}
    assert stored(repo, "settled")["notes"] == "dinner with Sam"
    assert result["carried"] == 1


def test_a_twin_four_days_away_is_not_matched(repo, mirror):
    # [A13] Just outside the ±3-day skew → kept for the age-out.
    repo._table.seed(
        pending_row("kept"),
        pending_row("edited", day="2026-09-24", notes="dinner with Sam", **GUZMAN),
        pending_row("settled", status="posted", day="2026-09-28", **GUZMAN),
    )

    result = _run(mirror, repo)

    assert "edited" in stored_ids(repo)
    assert "notes" not in stored(repo, "settled")
    assert result["kept"] == 1


def test_a_posted_row_the_bank_still_lists_is_a_valid_twin_but_a_listed_pending_is_not_carried(repo, mirror):
    # [A14] A pending the bank still lists is never carried or removed, even with a twin stored.
    repo._table.seed(
        pending_row("kept", notes="still pending", **GUZMAN),
        pending_row("settled", status="posted", **GUZMAN),
    )

    result = _run(mirror, repo)

    assert stored_ids(repo) == {"kept", "settled"}
    assert "notes" not in stored(repo, "settled")
    assert result["carried"] == 0


# --- failure and race paths ----------------------------------------------------------------------


def test_the_webhook_settling_the_pending_mid_run_counts_gone_and_keeps_the_carry(repo, mirror):
    # [A15] Carry saved, then the pending posts before our conditional delete → gone, not lost.
    repo._table.seed(pending_row("kept"), pending_row("edited", notes="dinner with Sam", **GUZMAN), pending_row("settled", status="posted", **GUZMAN))
    repo._table.before_next_write(lambda key, table: table.store[(key["pk"], key["sk"])].update(status="posted"))

    result = _run(mirror, repo)

    assert stored(repo, "settled")["notes"] == "dinner with Sam"
    assert stored(repo, "edited")["status"] == "posted"
    assert result["gone"] == 1
    assert result["carried"] == 0
    assert result["failed"] == 0


def test_a_notes_only_retry_after_a_failed_delete_finishes_the_job(repo, mirror):
    # [A16] A notes-only carry leaves the twin unfiled, so it's still a candidate next hour:
    # the retry carries the same note again (no harm) and removes the pending.
    repo._table.seed(pending_row("kept"), pending_row("edited", notes="dinner with Sam", **GUZMAN), pending_row("settled", status="posted", **GUZMAN))
    repo._table.fail("delete_item")

    first = _run(mirror, repo)
    assert first["failed"] == 1
    assert "edited" in stored_ids(repo)

    repo._table.clear_failures()
    second = _run(mirror, repo)

    assert stored_ids(repo) == {"kept", "settled"}
    assert stored(repo, "settled")["notes"] == "dinner with Sam"
    assert second["carried"] == 1
    assert second["failed"] == 0


def test_one_failed_carry_does_not_stop_the_next_pending_carrying(repo, mirror):
    # [A17] Per-pending isolation: A's carry write fails (kept), B still carries.
    other = {"amount": Decimal("-7.00"), "merchant_name": "Coles", "description": "COLES 1234"}
    repo._table.seed(
        pending_row("kept"),
        pending_row("a", notes="lunch", **GUZMAN), pending_row("a_settled", status="posted", **GUZMAN),
        pending_row("b", notes="milk", **other), pending_row("b_settled", status="posted", **other),
    )
    repo._table.fail("batch_writer", when=lambda item: item["sk"] == "TXN#a_settled")

    result = _run(mirror, repo)

    assert stored_ids(repo) == {"kept", "a", "a_settled", "b_settled"}
    assert stored(repo, "b_settled")["notes"] == "milk"
    assert "notes" not in stored(repo, "a_settled")
    assert result["failed"] == 1
    assert result["carried"] == 1


def test_the_carry_is_saved_before_the_pending_is_deleted(repo, mirror):
    # [A18] Never lose an edit: the batch put of the twin happens first, the delete after.
    repo._table.seed(pending_row("kept"), pending_row("edited", notes="dinner with Sam", **GUZMAN), pending_row("settled", status="posted", **GUZMAN))
    order = []
    real_insert, real_delete = repo.insert_transactions, repo.delete_if_still_pending

    def insert(rows):
        order.append("carry")
        return real_insert(rows)

    def delete(pk, sk):
        order.append("delete")
        return real_delete(pk, sk)

    repo.insert_transactions, repo.delete_if_still_pending = insert, delete

    _run(mirror, repo)

    assert order == ["carry", "delete"]


def test_the_cap_counts_edited_pendings_and_blocks_every_carry(repo, mirror):
    # [A19] Regression: 11 missing (edited ones included) → the whole account is skipped.
    repo._table.seed(
        pending_row("kept"),
        pending_row("edited", notes="dinner with Sam", **GUZMAN),
        pending_row("settled", status="posted", **GUZMAN),
        *(pending_row(f"missing{n}") for n in range(10)),
    )

    result = _run(mirror, repo)

    assert result["skipped"] == "too_many_removals"
    assert "edited" in stored_ids(repo)
    assert "notes" not in stored(repo, "settled")


# --- mirror_pendings end to end ------------------------------------------------------------------


def test_mirror_pendings_carries_with_the_real_taxonomy_and_reports_it(repo, mirror, caplog):
    # [A20] The taxonomy check from the category repo drives the carry; the summary and its log
    # line carry the new count.
    repo._table.seed(
        pending_row("kept"),
        pending_row("edited", category="groceries", **GUZMAN),
        pending_row("settled", status="posted", **GUZMAN),
    )

    def fetch(api_key, bid, aid, date_from, date_to):
        return bank_rows("kept", aid=aid)

    with caplog.at_level(logging.INFO, logger="pending_mirror"):
        summary = mirror.mirror_pendings(
            "key", repo=repo, category_repo=_FakeCategoryRepo([{"id": "groceries"}]), today=MIRROR_TODAY, fetch=fetch
        )

    assert stored_ids(repo) == {"kept", "settled"}
    assert stored(repo, "settled")["category"] == "groceries"
    assert summary["carried"] == 1
    assert summary["accounts"][WESTPAC]["carried"] == 1
    assert summary["accounts"][UP]["carried"] == 0
    messages = [record.getMessage() for record in caplog.records]
    assert any("carried account=" + WESTPAC in m and "pending=edited" in m and "posted=settled" in m for m in messages)
    assert any("pending_mirror summary:" in m and "carried=1" in m for m in messages)


def test_a_category_read_failure_reports_zero_carried_and_touches_nothing(repo, mirror):
    # [A21] The skip-everything branch still has the new key, and no carry runs.
    repo._table.seed(pending_row("edited", notes="x", **GUZMAN), pending_row("settled", status="posted", **GUZMAN))

    summary = mirror.mirror_pendings(
        "key", repo=repo, category_repo=_FakeCategoryRepo(error=RuntimeError("down")), today=MIRROR_TODAY,
        fetch=lambda *args: bank_rows("kept", aid=args[2]),
    )

    assert summary["carried"] == 0
    assert "notes" not in stored(repo, "settled")
    assert "edited" in stored_ids(repo)


def test_a_twin_on_another_account_is_never_used(repo, mirror):
    # [A22] Twins come only from the same account's rows.
    repo._table.seed(
        pending_row("kept"),
        pending_row("edited", notes="dinner with Sam", **GUZMAN),
        pending_row("up_settled", status="posted", account_id=UP, **GUZMAN),
    )

    def fetch(api_key, bid, aid, date_from, date_to):
        return bank_rows("kept", aid=aid)

    summary = mirror.mirror_pendings("key", repo=repo, category_repo=_FakeCategoryRepo(), today=MIRROR_TODAY, fetch=fetch)

    assert "edited" in stored_ids(repo)
    assert "notes" not in stored(repo, "up_settled", account_id=UP)
    assert summary["kept"] == 1
    assert summary["carried"] == 0
