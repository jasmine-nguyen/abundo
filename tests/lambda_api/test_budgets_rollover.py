"""Tests for budget ROLLOVER (envelope carryover) in GET /budgets.

A rollover category accumulates each cycle's leftover (target - spend) into a signed
`carryover` buffer: a sinking fund builds up until a bill lands, a spike cycle carries its
overspend as a deficit. The buffer is sealed lazily on read (write-on-read, best-effort):
completed cycles older than the settle lag fold into the stored balance; the recent unsealed
cycles are recomputed live. These tests pin that flow.

`handler.current_cycle_window` is monkeypatched to a fixed (cycle_start, today) so the cycle
math is deterministic (the real one reads the wall clock). The pure stepping helper
`completed_cycle_windows` is exercised directly in tests/shared/test_spend_windows.py.
"""

import pathlib
from decimal import Decimal

import pytest

from _lambda_api_constants import constants_namespace

# A fixed monthly cycle: current cycle_start 2026-08-06, today 2026-08-10 (4 days in), payday
# grid anchored at 2026-01-01. The settle lag is 10 days, so the cutoff is 2026-07-31: a
# completed cycle whose end is before that seals; a more recent one stays live.
CYCLE_START = "2026-08-06"
TODAY = "2026-08-10"
LENGTH = 30
PAYDATE = "2026-01-01"
_ROOT = pathlib.Path(__file__).resolve().parents[2]


class FakeBudgetRepo:
    def __init__(self, budgets):
        self._budgets = budgets
        self.settle_calls = []
        self.settle_raises = False

    def list_budgets(self):
        return {k: dict(v) for k, v in self._budgets.items()}

    def settle_carryover(self, cat_id, carryover, carryover_from, carryover_len, carryover_paydate):
        self.settle_calls.append((cat_id, carryover, carryover_from, carryover_len, carryover_paydate))
        if self.settle_raises:
            raise RuntimeError("boom")   # exercises the best-effort swallow
        self._budgets.setdefault(cat_id, {}).update({
            "carryover": carryover, "carryover_from": carryover_from,
            "carryover_len": Decimal(carryover_len), "carryover_paydate": carryover_paydate,
        })


class FakeTransactionRepo:
    """Returns the queued page on the first account, empty after — so each transaction is
    summed once (mirrors the /budgets per-account loop)."""

    def __init__(self, transactions=None):
        self._queue = [(list(transactions or []), None)]

    def get_transactions_by_date_range(self, account_id, start_date, end_date, limit=20, cursor=None):
        return self._queue.pop(0) if self._queue else ([], None)


class FakePayCycleRepo:
    def __init__(self, length=LENGTH, last_pay_date=PAYDATE):
        self._cycle = {"length": length, "last_pay_date": last_pay_date}

    def get_paycycle(self):
        return dict(self._cycle)


class FakeCategoryRepo:
    def __init__(self, categories):
        self._categories = categories

    def list_categories(self):
        return [dict(c) for c in self._categories]


def _txn(category, amount, date, status="posted", counts=True):
    return {"category": category, "amount": Decimal(str(amount)), "status": status,
            "date": date, "counts_to_budget": counts}


def _spend_cat(cat_id="sink", bucket="Lifestyle"):
    return [{"id": cat_id, "bucket": bucket, "parent": None}]


@pytest.fixture(autouse=True)
def _fixed_window(handler, monkeypatch):
    # Deterministic current cycle, independent of the wall clock.
    monkeypatch.setattr(handler, "current_cycle_window",
                        lambda last_pay_date, length, today=None: (CYCLE_START, TODAY))


def _entry(target, **extra):
    entry = {"target": Decimal(str(target)), "rollover": True,
             "carryover_len": Decimal(LENGTH), "carryover_paydate": PAYDATE}
    entry.update(extra)
    return entry


# --- sinking fund: unused budget accumulates ---------------------------------


def test_empty_cycles_accumulate_into_the_buffer_and_seal_the_settled_ones(handler):
    # Anchor 3 cycles back (2026-05-08), all empty, target 100/cycle. Two oldest cycles are
    # older than the 10-day lag -> sealed (200); the most recent completed cycle is still live
    # (+100). Displayed carryover = 300; the seal advances the anchor past the two sealed cycles.
    budget_repo = FakeBudgetRepo({"sink": _entry(100, carryover=Decimal(0), carryover_from="2026-05-08")})
    result = handler.list_budgets(budget_repo, FakeTransactionRepo(), FakePayCycleRepo(), FakeCategoryRepo(_spend_cat()))

    assert result["sink"]["rollover"] is True
    assert result["sink"]["carryover"] == Decimal(300)
    # Only the two lag-cleared cycles were sealed into the stored balance (200), anchor -> the
    # start of the still-live cycle (2026-07-07).
    assert budget_repo.settle_calls == [("sink", Decimal(200), "2026-07-07", LENGTH, PAYDATE)]


def test_sinking_fund_covers_the_bill_when_it_lands(handler):
    # Same 3 empty prior cycles (buffer 300) + target 100 => available 400 this cycle; a $300
    # bill posts in the current cycle. The server reports posted 300 against carryover 300, so
    # the client's remaining (target + carryover - spent) is a calm +100, not "over".
    budget_repo = FakeBudgetRepo({"sink": _entry(100, carryover=Decimal(0), carryover_from="2026-05-08")})
    txns = FakeTransactionRepo([_txn("sink", -300, "2026-08-08")])  # current cycle
    result = handler.list_budgets(budget_repo, txns, FakePayCycleRepo(), FakeCategoryRepo(_spend_cat()))

    assert result["sink"]["posted"] == Decimal(300)
    assert result["sink"]["carryover"] == Decimal(300)


# --- spike / borrow: overspend carries as a deficit --------------------------


def test_overspend_in_the_live_cycle_carries_as_a_negative_buffer_without_sealing(handler):
    # Anchor one cycle back (2026-07-07): that completed cycle is still within the lag (ends
    # 2026-08-05), so it is NOT sealed. A $150 spend against target 100 => leftover -50, shown
    # live as a -50 buffer. Nothing seals, so the anchor doesn't move and no settle is written.
    budget_repo = FakeBudgetRepo({"sink": _entry(100, carryover=Decimal(0), carryover_from="2026-07-07")})
    txns = FakeTransactionRepo([_txn("sink", -150, "2026-07-20")])  # in the completed (unsealed) cycle
    result = handler.list_budgets(budget_repo, txns, FakePayCycleRepo(), FakeCategoryRepo(_spend_cat()))

    assert result["sink"]["carryover"] == Decimal(-50)
    # The widened fetch is sliced back to the current cycle for posted/pending: the prior-cycle
    # spend must NOT leak into current-cycle posted (fail-on-revert for the `current` slice).
    assert result["sink"]["posted"] == Decimal(0)
    assert budget_repo.settle_calls == []   # unsealed -> no write


# --- pay-cycle change re-anchors (freezes) instead of double-counting --------


def test_a_pay_cycle_length_change_freezes_the_buffer_and_re_anchors(handler):
    # Buffer was sealed under a 14-day cycle; the user is now monthly (30). The stored anchor
    # is fictional against the new grid, so freeze the balance (40) and re-anchor to the
    # current cycle_start under the new length — no cycles are folded this read.
    budget_repo = FakeBudgetRepo({"sink": {
        "target": Decimal(100), "rollover": True, "carryover": Decimal(40),
        "carryover_from": "2026-05-08", "carryover_len": Decimal(14), "carryover_paydate": PAYDATE,
    }})
    result = handler.list_budgets(budget_repo, FakeTransactionRepo(), FakePayCycleRepo(), FakeCategoryRepo(_spend_cat()))

    assert result["sink"]["carryover"] == Decimal(40)   # frozen, not re-folded
    assert budget_repo.settle_calls == [("sink", Decimal(40), CYCLE_START, LENGTH, PAYDATE)]


# --- scope: rollover is spend-only -------------------------------------------


def test_rollover_flag_on_a_re_bucketed_income_category_is_ignored(handler):
    # The flag was set while the category was spend; it was later re-bucketed to Income. On
    # read it falls through to the plain earn-target output (no rollover/carryover keys), and
    # nothing is sealed — earnings must never fold into a spend buffer.
    budget_repo = FakeBudgetRepo({"sink": _entry(100, carryover=Decimal(0), carryover_from="2026-05-08")})
    result = handler.list_budgets(budget_repo, FakeTransactionRepo(), FakePayCycleRepo(),
                                  FakeCategoryRepo(_spend_cat(bucket="Income")))

    assert "rollover" not in result["sink"]
    assert "carryover" not in result["sink"]
    assert budget_repo.settle_calls == []


def test_a_non_rollover_budget_is_byte_identical_to_before(handler):
    # No rollover flag -> the wire shape is exactly {target, posted, pending}, no extra keys,
    # and the fetch is not widened (settlement never runs).
    budget_repo = FakeBudgetRepo({"food": {"target": Decimal(250)}})
    txns = FakeTransactionRepo([_txn("food", -40, "2026-08-08")])
    result = handler.list_budgets(budget_repo, txns, FakePayCycleRepo(), FakeCategoryRepo(_spend_cat("food")))

    assert result == {"food": {"target": Decimal(250), "posted": Decimal(40), "pending": Decimal(0)}}
    assert budget_repo.settle_calls == []


# --- robustness --------------------------------------------------------------


def test_a_failed_settle_write_never_500s_the_read(handler):
    # The seal write is best-effort: even if settle_carryover raises, the live carryover is
    # still computed and returned (it just re-seals on the next read).
    budget_repo = FakeBudgetRepo({"sink": _entry(100, carryover=Decimal(0), carryover_from="2026-05-08")})
    budget_repo.settle_raises = True
    result = handler.list_budgets(budget_repo, FakeTransactionRepo(), FakePayCycleRepo(), FakeCategoryRepo(_spend_cat()))

    assert result["sink"]["carryover"] == Decimal(300)   # displayed regardless of the write
    assert budget_repo.settle_calls != []                # it did attempt the write


def test_settlement_is_bounded_by_the_max_lookback_cap(handler):
    # Anchor 20 empty cycles back but the cap is 12 -> only 12 are folded (12 * 100 = 1200),
    # NOT 2000; the older leftovers are dropped and the anchor jumps forward. Fail-on-revert
    # for the cold-start bound: without the cap this would read 2000.
    old_anchor = "2025-01-09"  # ~20 monthly cycles before 2026-08-06
    budget_repo = FakeBudgetRepo({"sink": _entry(100, carryover=Decimal(0), carryover_from=old_anchor)})
    result = handler.list_budgets(budget_repo, FakeTransactionRepo(), FakePayCycleRepo(), FakeCategoryRepo(_spend_cat()))

    assert result["sink"]["carryover"] == Decimal(1200)


# --- constant drift guard ----------------------------------------------------


def test_rollover_settle_lag_equals_shared_pending_age_out():
    # The lag is handler-only but its VALUE must track shared PENDING_AGE_OUT_DAYS (the point
    # past which a transaction can no longer move). If the age-out window changes and this
    # doesn't, the plan's rationale silently breaks — this test fails first.
    api = constants_namespace(_ROOT / "lambda_api" / "constants.py")
    shared = constants_namespace(_ROOT / "shared" / "constants.py")
    assert api["ROLLOVER_SETTLE_LAG_DAYS"] == shared["PENDING_AGE_OUT_DAYS"]
