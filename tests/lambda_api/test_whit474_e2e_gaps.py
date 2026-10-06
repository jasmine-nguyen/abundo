"""WHIT-474 — adversarial GAP coverage for the rollover-clear cascade.

The implementer tested the PIECES (clear_rollover at the repo, the cascade fires at the
handler) but never the true regression: the REAL BudgetRepository's clear feeding the REAL
list_budgets fold. These attack that seam and the error/edge paths the piece-tests miss.

Complements (does NOT duplicate):
  * tests/shared/test_repository_budget.py  — clear_rollover unit behaviour
  * tests/lambda_api/test_categories.py     — cascade fires / best-effort swallow (mocked repo)

`handler.current_cycle_window` is pinned per test so the cycle math is deterministic.
Uses the REAL handler.BudgetRepository over the shared FakeTable so a clear actually strips
fields that a later list_budgets read must honour.
"""

import json
from decimal import Decimal
from functools import partial

import pytest

from _budget_endpoint_fakes import _FakePayCycleRepo
from _category_fakes import _cat, _schema
from _dynamo_fakes import FakeTable
from _transaction_range_fakes import _QueuedTransactionRepo

LENGTH = 30
PAYDATE = "2026-01-01"
CYCLE_START = "2026-08-06"
TODAY = "2026-08-10"


_KEY = ("BUDGETS", "BUDGETS")


def _config_table(items, version=1):
    """The shared FakeTable holding the ONE budgets config item (pk=sk="BUDGETS")."""
    table = FakeTable()
    table.seed({"pk": "BUDGETS", "sk": "BUDGETS", "items": items, "version": Decimal(version)})
    return table


FakePayCycleRepo = partial(_FakePayCycleRepo, length=LENGTH, last_pay_date=PAYDATE)


def _category_repo(cat_id, bucket):
    """The REAL CategoryRepository over a FakeTable holding the one category, so a re-bucket
    lands in the store and a later list_categories reads it back."""
    import repository
    repo = repository.CategoryRepository()
    repo._table = FakeTable()
    repo._table.seed({"pk": "CATEGORIES", "sk": "CATEGORIES", "version": Decimal(1),
                      "items": {cat_id: _cat(cat_id, bucket, parent=None)},
                      "colorSlotSchema": _schema()})
    return repo


def _stored_bucket(cat_repo, cat_id):
    return cat_repo._table.store[("CATEGORIES", "CATEGORIES")]["items"][cat_id]["bucket"]


def _event(bucket, cat_id="sink"):
    return {
        "rawPath": f"/categories/{cat_id}",
        "requestContext": {"http": {"method": "PATCH"}},
        "pathParameters": {"id": cat_id},
        "body": json.dumps({"name": "Sink", "bucket": bucket}),
        "isBase64Encoded": False,
    }


def _rollover_entry(target=100, carryover=0, carryover_from="2026-05-08"):
    # An OLD anchor (3 cycles back) aligned to the current pay cycle: WOULD fold every cycle
    # since if it were still treated as rollover. carryover starts 0 so any non-zero result
    # is purely re-folded past cycles (the exact WHIT-474 buffer resurrection).
    return {
        "target": Decimal(target), "rollover": True, "carryover": Decimal(carryover),
        "carryover_from": carryover_from, "carryover_len": Decimal(LENGTH),
        "carryover_paydate": PAYDATE,
    }


@pytest.fixture(autouse=True)
def _fixed_window(handler, monkeypatch):
    import budget_standing
    for module in (handler, budget_standing):
        monkeypatch.setattr(module, "current_cycle_window",
                            lambda last_pay_date, length, today=None: (CYCLE_START, TODAY))


def _budget_repo(handler, table):
    r = handler.BudgetRepository()
    r._table = table
    return r


# --- [A1] the true regression: real clear -> re-bucket back -> no re-fold ------


def test_rebucket_to_income_then_back_to_spend_does_not_resurrect_the_buffer(handler):
    # WHIT-474 — [A1] END-TO-END against the REAL BudgetRepository + REAL list_budgets fold:
    # a rollover sink with a 3-cycle-old anchor -> re-bucket to Income (REAL clear strips the
    # fields, keeps the target) -> re-bucket back to a spend bucket -> GET /budgets. The buffer
    # must NOT reappear and NO past cycle may re-fold. FAIL-ON-REVERT: drop the handler cascade
    # and the surviving anchor re-folds 3 empty cycles -> carryover 300, reddening this.
    table = _config_table(items={"sink": _rollover_entry()})
    budget_repo = _budget_repo(handler, table)
    cat_repo = _category_repo("sink", "Lifestyle")

    to_income = handler.update_category(_event("Income"), cat_repo, budget_repo)
    assert to_income["statusCode"] == 200
    # the REAL clear ran on the REAL store: only the dollar target survives.
    assert table.store[_KEY]["items"]["sink"] == {"target": Decimal(100)}

    back_to_spend = handler.update_category(_event("Lifestyle"), cat_repo, budget_repo)
    assert back_to_spend["statusCode"] == 200

    result = handler.list_budgets(budget_repo, _QueuedTransactionRepo(), FakePayCycleRepo(), cat_repo)

    row = result["sink"]
    assert row["target"] == Decimal(100)          # the target is intact
    assert "carryover" not in row                 # no buffer resurrected
    assert "rollover" not in row                  # and it reads as a plain non-rollover budget


def test_cleared_entry_serialises_through_list_budgets_with_no_leftover_rollover_keys(handler):
    # WHIT-474 — [A2] Decimal/JSON edge: after the real clear, the row must render cleanly
    # through the API's DecimalEncoder with NO stray rollover/carryover keys — the wire shape
    # is byte-identical to a budget that never had rollover. FAIL-ON-REVERT: skip the clear and
    # the serialised row carries "rollover"/"carryover".
    table = _config_table(items={"sink": _rollover_entry()})
    budget_repo = _budget_repo(handler, table)
    cat_repo = _category_repo("sink", "Lifestyle")

    handler.update_category(_event("Income"), cat_repo, budget_repo)
    handler.update_category(_event("Lifestyle"), cat_repo, budget_repo)
    result = handler.list_budgets(budget_repo, _QueuedTransactionRepo(), FakePayCycleRepo(), cat_repo)

    wire = json.loads(handler._json_response(200, result)["body"])
    assert wire["sink"] == {"available": 100, "target": 100, "posted": 0, "pending": 0}


# --- best-effort FAILURE is a KNOWN LIMITATION, not corruption ----------------


def test_swallowed_clear_leaves_a_recoverable_stale_anchor_not_corruption(handler):
    # WHIT-474 — [A4] Documents the limitation the fix ACCEPTS: if the clear loses every version
    # race it is swallowed (200), so the stale anchor SURVIVES and a later move back to spend
    # re-folds the buffer. That is a recoverable stale anchor (all rollover fields intact, target
    # intact), NOT a corrupt entry — the property the best-effort posture guarantees. If this ever
    # starts asserting a CLEARED entry, the swallow was tightened and this doc-test should be
    # revisited. FAIL-ON-REVERT: narrow the handler catch and the swallowed VersionConflict raises.
    table = _config_table(items={"sink": _rollover_entry()})
    table.always_race()                    # every clear attempt loses the lock -> raises, swallowed
    budget_repo = _budget_repo(handler, table)
    cat_repo = _category_repo("sink", "Lifestyle")

    resp = handler.update_category(_event("Income"), cat_repo, budget_repo)

    assert resp["statusCode"] == 200                       # swallowed, edit still succeeds
    stale = table.store[_KEY]["items"]["sink"]
    assert stale["rollover"] is True                       # anchor intact (recoverable)
    assert stale["carryover_from"] == "2026-05-08"         # not cleared
    assert stale["target"] == Decimal(100)                 # never corrupted

    # The known consequence: back to spend, the surviving anchor re-folds the empty cycles.
    handler.update_category(_event("Lifestyle"), cat_repo, budget_repo)
    result = handler.list_budgets(budget_repo, _QueuedTransactionRepo(), FakePayCycleRepo(), cat_repo)
    assert result["sink"]["carryover"] > Decimal(0)        # the buffer resurrects (documented gap)


# --- non-DB error from the real clear must PROPAGATE (mirror WHIT-127) ---------


def test_clear_rollover_non_db_error_is_not_swallowed(handler, monkeypatch):
    # WHIT-474 — [A3] The handler cascade catches ONLY (VersionConflictError, DatabaseError). A
    # non-DB fault from clear_rollover (a logic bug: KeyError/RuntimeError) must NOT be masked as
    # a 200 — it propagates so the bug surfaces (-> Lambda 500), exactly like the WHIT-127 delete
    # cascade. FAIL-ON-REVERT: widen the handler catch to Exception and this stops raising.
    table = _config_table(items={"sink": _rollover_entry()})
    budget_repo = _budget_repo(handler, table)

    def boom(cat_id):
        raise RuntimeError("bug: not a DB error")
    monkeypatch.setattr(budget_repo, "clear_rollover", boom)
    cat_repo = _category_repo("sink", "Lifestyle")

    with pytest.raises(RuntimeError, match="bug"):
        handler.update_category(_event("Income"), cat_repo, budget_repo)


# --- Savings arm on an UNbudgeted category is a clean real no-op ---------------


def test_rebucket_to_savings_unbudgeted_is_a_clean_noop(handler):
    # WHIT-474 — [A5] WHIT-202 rejects a re-bucket to Savings while budgeted, so the Savings arm
    # of the clear can only ever run on an UNbudgeted category — where clear_rollover finds no
    # entry and must be a silent no-op (no seed, no write, no version bump). Proven against the
    # REAL repo. FAIL-ON-REVERT: make the absent-entry branch write and this reddens.
    table = _config_table(items={"food": {"target": Decimal(80)}}, version=4)  # 'sink' absent
    budget_repo = _budget_repo(handler, table)
    cat_repo = _category_repo("sink", "Living")

    resp = handler.update_category(_event("Savings"), cat_repo, budget_repo)

    assert resp["statusCode"] == 200
    assert _stored_bucket(cat_repo, "sink") == "Savings"             # the re-bucket stuck
    assert table.update_calls == []                 # clear found nothing -> never wrote
    assert table.store[_KEY]["version"] == Decimal(4)     # version untouched
