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

MARKER = "UP_WEBHOOK_REPAYMENT_MISSED"
_DAY = 24 * 60 * 60
NOW = 1_800_000_000  # fixed epoch so the window is deterministic


class _FakeTxnRepo:
    def __init__(self, rows):
        self._rows = rows
        self.calls = []

    def get_transactions_by_date_range(self, account_id, start_date, end_date, limit):
        self.calls.append((account_id, start_date, end_date, limit))
        return list(self._rows), None


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
    handler.check_ingested_repayment_without_push(notify, _FakeTxnRepo(rows), NOW)
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


# --- the four false-negative edges the card names --------------------------

def test_interest_same_day_still_alarms(handler, caplog):
    # A repayment credit + a same-day interest debit. The balance-drop check nets these;
    # this one keys on the credit alone, so a missed push on the credit still alarms — and
    # the interest debit is not itself treated as a repayment.
    rows = [_row("3573.00"), _row("-234.82")]
    text = _run(handler, caplog, rows=rows, push_amounts=[])
    assert _alarm_count(text) == 1  # the credit, not the debit


def test_two_repayments_one_missed_alarms(handler, caplog):
    # Two repayments in the window; only the first pushed. Intra-window masking defeated.
    rows = [_row("3573.00"), _row("4000.00")]
    text = _run(handler, caplog, rows=rows, push_amounts=[357300])
    assert _alarm_count(text) == 1
    assert "400000 cents" in text  # the unmatched one


def test_split_repayment_both_legs_alarm(handler, caplog):
    # One repayment split into two sub-$3,000 legs — each below the balance-drop threshold
    # but each a real credit above the $10 floor. Net-drop blindness defeated.
    rows = [_row("1500.00"), _row("1600.00")]
    text = _run(handler, caplog, rows=rows, push_amounts=[])
    assert _alarm_count(text) == 2


def test_fires_without_any_balance_input(handler, caplog):
    # The detector reads no balance at all, so a pre-upsert balance-read hiccup (which blinds
    # the WHIT-316 check) cannot suppress it — a missed repayment still alarms.
    text = _run(handler, caplog, rows=[_row("3573.00")], push_amounts=[])
    assert MARKER in text


# --- same-amount masking (the edge Option B would have reopened) -----------

def test_same_amount_second_repayment_alarms(handler, caplog):
    # Two repayments of the SAME amount, only one push. The consuming match leaves the
    # second unmatched → exactly one alarm (set-membership would have masked it).
    rows = [_row("3573.00"), _row("3573.00")]
    text = _run(handler, caplog, rows=rows, push_amounts=[357300])
    assert _alarm_count(text) == 1


def test_same_amount_both_pushed_is_silent(handler, caplog):
    rows = [_row("3573.00"), _row("3573.00")]
    text = _run(handler, caplog, rows=rows, push_amounts=[357300, 357300])
    assert MARKER not in text


# --- units: dollars (store) vs cents (push marker) -------------------------

def test_dollar_row_matches_cents_marker(handler, caplog):
    # A $3,000.00 stored row (dollars) matches a 300000-cent push marker.
    text = _run(handler, caplog, rows=[_row("3000.00")], push_amounts=[300000])
    assert MARKER not in text


def test_dollar_amount_does_not_match_a_dollar_marker(handler, caplog):
    # If the marker were dollars (3000) instead of cents (300000), matching would break —
    # this proves the detector really compares cents on both sides.
    text = _run(handler, caplog, rows=[_row("3000.00")], push_amounts=[3000])
    assert MARKER in text


# --- negatives -------------------------------------------------------------

def test_sub_floor_repayment_is_silent(handler, caplog):
    # A $5 OHA-test credit is below the $10 notify floor → not a qualifying repayment.
    text = _run(handler, caplog, rows=[_row("5.00")], push_amounts=[])
    assert MARKER not in text


def test_non_repayment_type_ignored(handler, caplog):
    text = _run(handler, caplog, rows=[_row("3573.00", type_="TRANSFER_OUTGOING")], push_amounts=[])
    assert MARKER not in text


def test_malformed_amount_skipped(handler, caplog):
    rows = [{"type": "TRANSFER_INCOMING", "amount": None, "date": "2026-07-04"}]
    text = _run(handler, caplog, rows=rows, push_amounts=[])
    assert MARKER not in text


def test_empty_window_short_circuits_before_reading_pushes(handler, caplog):
    notify = _FakeNotify([])
    _run(handler, caplog, rows=[], notify=notify)
    assert notify.since_cutoff is None  # never asked for pushes when there's nothing to match


# --- window plumbing -------------------------------------------------------

def test_reads_the_homeloan_account_over_the_lookback(handler):
    repo = _FakeTxnRepo([])
    handler.check_ingested_repayment_without_push(_FakeNotify(), repo, NOW)
    account_id, start_date, end_date, _limit = repo.calls[0]
    assert account_id == handler.HOMELOAN_ACCOUNT_ID
    assert start_date == "2027-01-08"  # NOW - 7 days, UTC (NOW = 2027-01-15)
    assert end_date == "2027-01-15"


def test_push_window_cutoff_is_midnight_of_the_oldest_day(handler, caplog):
    # The push cutoff is midnight of start_date (not the mid-day NOW - 7d), so the push
    # window is at least as broad as the date-based store window — no boundary false alarm.
    notify = _FakeNotify([357300])
    _run(handler, caplog, rows=[_row("3573.00")], notify=notify)
    assert notify.since_cutoff == calendar.timegm(time.strptime("2027-01-08", "%Y-%m-%d"))
