"""Plain-data tests for the settlement planner's other steps (WHIT-624): the looser match
tiers, the swipe-date fix, the bank-field update and the in-memory `apply_plan`. No
FakeTable — the pinned acceptance tests live in test_reconcile_plan.py."""

import sys
from decimal import Decimal

import pytest

_ACCOUNT = "acc-1"
_PK = "ACCOUNT#acc-1"


@pytest.fixture
def reconcile(lam):
    sys.modules.pop("reconcile", None)
    import reconcile as module
    yield module
    sys.modules.pop("reconcile", None)


def _charge(transaction_id, amount, authorized_date, *, status="posted", date=None):
    return {
        "transaction_id": transaction_id,
        "account_id": _ACCOUNT,
        "amount": Decimal(amount),
        "authorized_date": authorized_date,
        "date": date or authorized_date,
        "merchant_name": "ISAN THAI",
        "description": "ISAN THAI MELBOURNE",
        "status": status,
        "category": "FOOD_AND_DRINK",
    }


def _stored(row, category="eating out"):
    return {**row, "pk": _PK, "sk": f"TXN#{row['transaction_id']}", "category": category}


def test_skewed_date_twin_settles_and_takes_the_pending_swipe_day(reconcile):
    pending = _stored(_charge("PEND", "-12.00", "2026-06-29", status="pending"))
    posted = _charge("POST", "-12.00", "2026-06-28", date="2026-07-01")

    plan = reconcile.plan_reconcile([posted], {}, {_ACCOUNT: [pending]})

    assert plan.steps == [("settle", posted, pending)]
    assert plan.stale_pending_keys == [(_PK, "TXN#PEND")]
    settled = reconcile.settle(posted, pending)
    assert (settled["date"], settled["authorized_date"]) == ("2026-06-29", "2026-06-29")
    assert settled["category"] == "eating out"


def test_blank_swipe_date_settlement_matches_within_the_window_and_takes_its_dates(reconcile):
    pending = _stored(_charge("PEND", "-30.00", "2026-06-27", status="pending"))
    posted = _charge("POST", "-30.00", None, date="2026-06-30")

    plan = reconcile.plan_reconcile([posted], {}, {_ACCOUNT: [pending]})

    assert plan.steps == [("settle", posted, pending)]
    settled = reconcile.settle(posted, pending)
    assert (settled["date"], settled["authorized_date"]) == ("2026-06-27", "2026-06-27")


def test_resend_leaves_the_later_pending_for_its_own_settlement_in_the_same_batch(reconcile):
    # WHIT-331: a re-send dated a day before a later pending must not take part in matching,
    # so the later pending's own settlement still claims it.
    stored = _stored(_charge("POST", "-74.46", "2026-06-28"))
    later_pending = _stored(_charge("PEND", "-74.46", "2026-06-29", status="pending"))
    resent = _charge("POST", "-74.46", "2026-06-28")
    later_posted = _charge("POST-2", "-74.46", "2026-06-29")

    plan = reconcile.plan_reconcile([resent, later_posted], {"POST": stored}, {_ACCOUNT: [later_pending]})

    assert plan.steps == [("update", resent, stored), ("settle", later_posted, later_pending)]


def test_unmatched_settlement_is_a_plain_insert(reconcile):
    posted = _charge("POST", "-30.00", "2026-06-27")

    plan = reconcile.plan_reconcile([posted], {}, {})

    assert plan.steps == [("insert", posted)]
    assert plan.stale_pending_keys == []


def test_pending_resend_in_the_same_batch_as_its_settlement_does_not_survive(reconcile):
    stored_pending = _stored(_charge("PEND", "-70.00", "2026-07-11", status="pending"), "groceries")
    posted = _charge("POST", "-70.00", "2026-07-11", date="2026-07-14")
    resend = _charge("PEND", "-70.00", "2026-07-11", status="pending")

    plan = reconcile.plan_reconcile([posted, resend], {}, {_ACCOUNT: [stored_pending]})
    rows = reconcile.apply_plan({"PEND": stored_pending}, plan)

    assert list(rows) == ["POST"]
    assert rows["POST"]["category"] == "groceries"


def test_update_keeps_the_stored_user_fields_and_overwrites_only_bank_fields(reconcile):
    stored = {**_stored(_charge("POST", "-10.00", "2026-06-29")), "filed_by_rule": "rule-1", "notes": "lunch"}
    resent = _charge("POST", "-10.50", "2026-06-29")
    rows_by_id = {"POST": stored}

    plan = reconcile.plan_reconcile([resent], {"POST": stored}, {})
    rows = reconcile.apply_plan(rows_by_id, plan)

    assert rows["POST"]["amount"] == Decimal("-10.50")
    assert rows["POST"]["category"] == "eating out"
    assert rows["POST"]["filed_by_rule"] == "rule-1"
    assert rows["POST"]["notes"] == "lunch"
    assert rows_by_id == {"POST": stored}


def test_update_of_a_missing_row_inserts_the_charge(reconcile):
    resync = _charge("PEND", "-4.00", "2026-06-29", status="pending")

    rows = reconcile.apply_plan({}, reconcile.plan_reconcile([resync], {}, {}))

    assert rows == {"PEND": resync}


def test_bank_field_updates_keep_the_corrected_swipe_day_on_a_resend(reconcile):
    stored = _stored(_charge("POST", "-12.00", "2026-06-29"))
    resent = _charge("POST", "-12.00", "2026-06-28", date="2026-07-01")

    updates = reconcile.bank_field_updates(resent, stored)

    assert (updates["date"], updates["authorized_date"]) == ("2026-06-29", "2026-06-29")
    assert "category" not in updates
    assert updates["amount"] == Decimal("-12.00")


def test_bank_field_updates_without_a_source_take_the_bank_dates(reconcile):
    resent = _charge("POST", "-12.00", "2026-06-28", date="2026-07-01")

    updates = reconcile.bank_field_updates(resent)

    assert (updates["date"], updates["authorized_date"]) == ("2026-07-01", "2026-06-28")
