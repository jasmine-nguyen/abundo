"""Tests for the precise repayment-miss detector (WHIT-317).

`check_ingested_repayment_without_push` lists the home-loan repayment credits ingested in
the last REPAYMENT_MISS_LOOKBACK_DAYS and logs `UP_WEBHOOK_REPAYMENT_MISSED source=txn`
(which the CloudWatch alarm watches) for any that has no matching push. Unlike the coarse
balance-drop check (WHIT-316), it keys on the transaction, so it survives interest-netting,
two-in-window masking, split drops, and a balance-read hiccup. Matches by amount in integer
cents, consuming one push per repayment.
"""

import calendar
import logging
import time
from decimal import Decimal

import pytest

from _transaction_range_fakes import _QueuedTransactionRepo

MARKER = "UP_WEBHOOK_REPAYMENT_MISSED"
_DAY = 24 * 60 * 60
NOW = 1_800_000_000  # fixed epoch so the window is deterministic


class _FakeNotify:
    def __init__(self, push_amounts=()):
        self._amounts = list(push_amounts)
        self.since_cutoff = None

    def repayment_push_amounts_since(self, cutoff):
        self.since_cutoff = cutoff
        return list(self._amounts)


def _row(amount, *, date="2026-07-04", type_="TRANSFER_INCOMING"):
    return {"type": type_, "amount": Decimal(str(amount)), "date": date}


def _run(handler, caplog, *, rows, push_amounts=(), notify=None):
    caplog.set_level(logging.ERROR)
    notify = notify or _FakeNotify(push_amounts)
    handler.check_ingested_repayment_without_push(notify, _QueuedTransactionRepo(rows), NOW)
    return caplog.text


def _alarm_count(text):
    return text.count(MARKER)


# --- happy path + the core miss --------------------------------------------

def test_repayment_with_matching_push_is_silent(handler, caplog):
    text = _run(handler, caplog, rows=[_row("3573.00")], push_amounts=[357300])
    assert MARKER not in text


def test_repayment_with_no_push_alarms(handler, caplog):
    text = _run(handler, caplog, rows=[_row("3573.00")], push_amounts=[])
    assert MARKER in text


def test_interest_same_day_still_alarms(handler, caplog):
    # A repayment credit + a same-day interest debit. The balance-drop check nets these;
    # this one keys on the credit alone, so a missed push on the credit still alarms — and
    # the interest debit is not itself treated as a repayment.
    rows = [_row("3573.00"), _row("-234.82")]
    text = _run(handler, caplog, rows=rows, push_amounts=[])
    assert _alarm_count(text) == 1  # the credit, not the debit


# --- same-amount masking (the edge Option B would have reopened) -----------

def test_same_amount_second_repayment_alarms(handler, caplog):
    # Two repayments of the SAME amount, only one push. The consuming match leaves the
    # second unmatched → exactly one alarm (set-membership would have masked it).
    rows = [_row("3573.00"), _row("3573.00")]
    text = _run(handler, caplog, rows=rows, push_amounts=[357300])
    assert _alarm_count(text) == 1


# --- units: dollars (store) vs cents (push marker) -------------------------

def test_dollar_row_matches_cents_marker(handler, caplog):
    # A $3,000.00 stored row (dollars) matches a 300000-cent push marker.
    text = _run(handler, caplog, rows=[_row("3000.00")], push_amounts=[300000])
    assert MARKER not in text


# --- negatives -------------------------------------------------------------

def test_non_repayment_type_ignored(handler, caplog):
    text = _run(handler, caplog, rows=[_row("3573.00", type_="TRANSFER_OUTGOING")], push_amounts=[])
    assert MARKER not in text


# --- window plumbing -------------------------------------------------------


def test_push_window_cutoff_is_midnight_of_the_oldest_day(handler, caplog):
    # The store is read for the home loan over the last 7 days (NOW = 2027-01-15, UTC). The push
    # cutoff is midnight of that start date (not the mid-day NOW - 7d), so the push window is at
    # least as broad as the date-based store window — no boundary false alarm.
    notify = _FakeNotify([357300])
    repo = _QueuedTransactionRepo([_row("3573.00")])
    caplog.set_level(logging.ERROR)

    handler.check_ingested_repayment_without_push(notify, repo, NOW)

    account_id, start_date, end_date, _limit, _cursor = repo.calls[0]
    assert (account_id, start_date, end_date) == (handler.HOMELOAN_ACCOUNT_ID, "2027-01-08", "2027-01-15")
    assert notify.since_cutoff == calendar.timegm(time.strptime("2027-01-08", "%Y-%m-%d"))


# --- adversarial edges: floor, mixed match/unmatch, rounding, pagination -----


def test_exactly_ten_dollars_is_a_qualifying_repayment(handler, caplog):
    # $10.00 == MIN_REPAYMENT_NOTIFY → NOT below the floor → alarms if unpushed.
    # Mirrors the webhook floor (valueInBaseUnits >= 1000).
    text = _run(handler, caplog, rows=[_row("10.00")], push_amounts=[])
    assert _alarm_count(text) == 1
    assert "1000 cents" in text


def test_just_below_ten_dollars_is_ignored(handler, caplog):
    # $9.99 < floor → not a repayment, no alarm even with zero pushes.
    text = _run(handler, caplog, rows=[_row("9.99")], push_amounts=[])
    assert MARKER not in text


def test_alarm_count_equals_unmatched_count(handler, caplog):
    # Three distinct repayments; only the middle one has a push. Exactly two alarms,
    # and the pushed amount is NOT among them.
    rows = [_row("3573.00"), _row("4000.00"), _row("5000.00")]
    text = _run(handler, caplog, rows=rows, push_amounts=[400000])
    assert _alarm_count(text) == 2
    assert "357300 cents" in text
    assert "500000 cents" in text
    assert "400000 cents" not in text  # consumed by its matching push


def test_odd_cent_amount_matches_its_cent_marker(handler, caplog):
    # $3,573.33 → 357333 cents (round, not truncate). A matching marker keeps it silent.
    text = _run(handler, caplog, rows=[_row("3573.33")], push_amounts=[357333])
    assert MARKER not in text


# --- a bad amount row never aborts the scan (WHIT-327 B) ----------------------
# Raw amounts (no Decimal(str(...)) wrap): float("inf") stays a genuine float so is_number's
# float branch (math.isfinite) is exercised. Without the guard, int(round(inf*100)) raises
# OverflowError and Decimal("NaN") > 0 raises InvalidOperation.


@pytest.mark.parametrize("bad_amount", [None, "not-a-number", float("inf"), Decimal("NaN")],
                         ids=["none", "non-numeric", "infinite", "decimal-nan"])
def test_a_bad_amount_row_is_skipped_and_the_valid_miss_still_alarms(handler, caplog, bad_amount):
    bad = {"type": "TRANSFER_INCOMING", "amount": bad_amount, "date": "2026-07-04"}

    text = _run(handler, caplog, rows=[bad, _row("3573.00")], push_amounts=[])

    assert _alarm_count(text) == 1
    assert "357300 cents" in text
