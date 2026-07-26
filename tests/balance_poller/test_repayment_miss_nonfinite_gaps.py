"""WHIT-327 (PART B) — the poller's DISTINCT non-finite crash mode.

The read-API tests cover get_repayment. The precise repayment-miss detector is a
SEPARATE Lambda and a SEPARATE call site (lambda_balance_poller/handler.py:231-234):
after is_repayment_credit it does `int(round(row["amount"] * 100))`. On a non-finite
amount that pre-PART-B slipped through:

  * float('inf')  → is_repayment_credit was True → int(round(inf*100)) → OverflowError
                    (a crash mode NO other test in the change touches);
  * Decimal('NaN') → is_repayment_credit raised InvalidOperation before we even got there.

Either way the detector (which the CloudWatch alarm depends on) would throw. PART B's
is_number now skips the leg, so the detector survives it and still catches a real miss
on a valid repayment in the same page.
"""

import logging
from decimal import Decimal

MARKER = "UP_WEBHOOK_REPAYMENT_MISSED"
NOW = 1_800_000_000  # fixed epoch (mirrors test_repayment_miss_precise.py)


class _FakeTxnRepo:
    def __init__(self, rows):
        self._rows = rows

    def get_transactions_by_date_range(self, account_id, start_date, end_date, limit):
        return list(self._rows), None


class _FakeNotify:
    def __init__(self, push_amounts=()):
        self._amounts = list(push_amounts)

    def repayment_push_amounts_since(self, cutoff):
        return list(self._amounts)


def _row(amount, *, date="2026-07-04", type_="TRANSFER_INCOMING"):
    # amount passed through as-is so callers can inject a raw float('inf').
    return {"type": type_, "amount": amount, "date": date}


def test_infinite_ingested_amount_does_not_crash_detector_and_valid_miss_still_alarms(handler, caplog):
    # [A_POLL_INF] (P0) A float('inf') repayment amount would (pre-PART-B) pass
    # is_repayment_credit and blow up at int(round(inf*100)) → OverflowError, killing the
    # miss detector. is_number now skips it; the scan continues and the valid $3573 repayment
    # with no matching push still alarms. [fail-on-revert] reverting the finiteness branches
    # makes this raise OverflowError.
    caplog.set_level(logging.ERROR)
    rows = [_row(float("inf")), _row(Decimal("3573.00"))]
    handler.check_ingested_repayment_without_push(_FakeNotify([]), _FakeTxnRepo(rows), NOW)
    assert caplog.text.count(MARKER) == 1   # only the valid repayment; the inf leg was skipped


def test_decimal_nan_ingested_amount_does_not_crash_detector(handler, caplog):
    # [A_POLL_NAN] (P0) A Decimal('NaN') repayment amount raised InvalidOperation inside
    # is_repayment_credit's `> 0` before PART B → the detector threw. Now skipped cleanly;
    # a valid repayment in the same page still alarms.
    caplog.set_level(logging.ERROR)
    rows = [_row(Decimal("NaN")), _row(Decimal("3573.00"))]
    handler.check_ingested_repayment_without_push(_FakeNotify([]), _FakeTxnRepo(rows), NOW)
    assert caplog.text.count(MARKER) == 1
