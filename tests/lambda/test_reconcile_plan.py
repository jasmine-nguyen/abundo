"""Acceptance tests for the pure settlement planner (WHIT-624).

`reconcile.plan_reconcile` takes plain data — the new charges, the stored posted rows
keyed by transaction_id, and the pending pools per account — and returns a plan. No
FakeTable, no repository: the matching decisions are checked on plain dicts.
"""

import sys
from decimal import Decimal

import pytest

_ACCOUNT = "acc-1"
_PK = "ACCOUNT#acc-1"


@pytest.fixture
def reconcile(lam):
    """The planner module, imported fresh on the webhook's sys.path (set by `lam`)."""
    sys.modules.pop("reconcile", None)
    import reconcile as module
    yield module
    sys.modules.pop("reconcile", None)


def _charge(transaction_id, amount, authorized_date, *, status="posted",
            merchant_name="ISAN THAI", description="ISAN THAI MELBOURNE", date=None):
    return {
        "transaction_id": transaction_id,
        "account_id": _ACCOUNT,
        "amount": Decimal(amount),
        "authorized_date": authorized_date,
        "date": date or authorized_date,
        "merchant_name": merchant_name,
        "description": description,
        "status": status,
        "category": "FOOD_AND_DRINK",
    }


def _pending_row(transaction_id, amount, authorized_date, *, category="eating out", **kw):
    row = _charge(transaction_id, amount, authorized_date, status="pending", **kw)
    row.update(pk=_PK, sk=f"TXN#{transaction_id}", category=category)
    return row


def test_exact_twin_is_never_starved_by_an_earlier_tip_match_in_the_batch(reconcile):
    # One pending -5.00 swiped 06-29. The batch holds a tip-eligible -5.50 posting FIRST
    # and the exact -5.00 posting second. The exact posting must claim the pending (WHIT-117);
    # the tipped one inserts plainly. The caller's pools are left untouched.
    pending = _pending_row("PEND", "-5.00", "2026-06-29")
    pools = {_ACCOUNT: [pending]}
    tipped = _charge("POST-TIP", "-5.50", "2026-06-29")
    exact = _charge("POST-EXACT", "-5.00", "2026-06-29")

    plan = reconcile.plan_reconcile([tipped, exact], {}, pools)

    assert plan.steps == [("insert", tipped), ("settle", exact, pending)]
    assert plan.stale_pending_keys == [(_PK, "TXN#PEND")]
    assert pools == {_ACCOUNT: [pending]}


def test_resent_charge_is_updated_in_place_and_kept_out_of_matching(reconcile):
    # POST was stored the first time it settled (swipe day 06-28). BankSync re-sends it.
    # A later, different pending (06-29, same amount + merchant) looks exactly like a
    # skewed-date twin — the re-send must NOT consume it (WHIT-331). A pending re-sync in
    # the same batch is a bank-field update with no date inheritance.
    stored = _charge("POST", "-74.46", "2026-06-28")
    stored.update(pk=_PK, sk="TXN#POST", category="eating out")
    later_pending = _pending_row("PEND-LATER", "-74.46", "2026-06-29")
    pools = {_ACCOUNT: [later_pending]}
    resent = _charge("POST", "-74.46", "2026-06-28")
    pending_resync = _charge("PEND-OTHER", "-12.00", "2026-06-30", status="pending",
                             merchant_name="COLES", description="COLES 0123 MELBOURNE")

    plan = reconcile.plan_reconcile([pending_resync, resent], {"POST": stored}, pools)

    assert plan.steps == [("update", pending_resync, None), ("update", resent, stored)]
    assert plan.stale_pending_keys == []
