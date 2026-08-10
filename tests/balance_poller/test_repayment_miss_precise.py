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
    def __init__(self, rows, cursor=None):
        self._rows = rows
        self._cursor = cursor
        self.calls = []

    def get_transactions_by_date_range(self, account_id, start_date, end_date, limit):
        self.calls.append((account_id, start_date, end_date, limit))
        return list(self._rows), self._cursor


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


def test_more_pushes_than_repayments_never_alarms(handler, caplog):
    # Leftover pushes (an earlier repayment already rolled off the store window but its
    # push is still in the marker window) must not manufacture an alarm.
    rows = [_row("3573.00")]
    text = _run(handler, caplog, rows=rows, push_amounts=[357300, 357300, 400000])
    assert MARKER not in text


def test_odd_cent_amount_matches_its_cent_marker(handler, caplog):
    # $3,573.33 → 357333 cents (round, not truncate). A matching marker keeps it silent.
    text = _run(handler, caplog, rows=[_row("3573.33")], push_amounts=[357333])
    assert MARKER not in text


def test_odd_cent_amount_without_push_reports_exact_cents(handler, caplog):
    text = _run(handler, caplog, rows=[_row("3573.33")], push_amounts=[])
    assert "357333 cents" in text


def test_detector_requests_max_page_size_and_ignores_the_cursor(handler, caplog):
    # The detector calls get_transactions_by_date_range with MAX_PAGE_SIZE and never
    # re-queries with the returned LastEvaluatedKey. This pins the single-page behaviour
    # so a >100-row 7-day window would silently drop the oldest repayments.
    repo = _FakeTxnRepo([_row("3573.00")], cursor={"pk": "more", "sk": "pages"})
    handler.check_ingested_repayment_without_push(_FakeNotify([357300]), repo, NOW)
    assert len(repo.calls) == 1  # cursor dropped: no second page fetched
    _account, _start, _end, limit = repo.calls[0]
    assert limit == handler.MAX_PAGE_SIZE


def test_non_numeric_amount_row_is_skipped_not_crashing_the_scan(handler, caplog):
    # A row with a non-numeric amount is skipped, so one garbled row can't abort the whole
    # miss-scan (the old `amount <= 0` would have raised TypeError). The valid repayment
    # beside it still alarms.
    garbled = {"type": "TRANSFER_INCOMING", "amount": "not-a-number", "date": "2026-07-04"}
    text = _run(handler, caplog, rows=[garbled, _row("3573.00")], push_amounts=[])
    assert _alarm_count(text) == 1
    assert "357300 cents" in text


# --- non-finite amounts: the detector's distinct crash mode (WHIT-327 B) -----
# These inject a RAW amount (no Decimal(str(...)) wrap). Keeping float("inf") a genuine
# float exercises is_number's float branch (math.isfinite); the Decimal-wrapping _row would
# turn it into Decimal("Infinity") and route both non-finite legs through the Decimal branch
# instead. is_number skips the bad leg either way, so the valid repayment beside it still
# alarms — but the raw passthrough keeps the float path honest. [fail-on-revert] reverting
# the finiteness guard makes int(round(inf*100)) raise OverflowError (and Decimal('NaN') > 0
# raise InvalidOperation).


def _raw_amount_row(amount, *, date="2026-07-04", type_="TRANSFER_INCOMING"):
    return {"type": type_, "amount": amount, "date": date}


def test_infinite_ingested_amount_does_not_crash_detector_and_valid_miss_still_alarms(handler, caplog):
    # A float('inf') repayment amount would (pre-PART-B) pass is_repayment_credit and blow up
    # at int(round(inf*100)) → OverflowError, killing the miss detector. is_number now skips
    # it; the scan continues and the valid $3573 repayment with no matching push still alarms.
    rows = [_raw_amount_row(float("inf")), _raw_amount_row(Decimal("3573.00"))]
    text = _run(handler, caplog, rows=rows, push_amounts=[])
    assert _alarm_count(text) == 1   # only the valid repayment; the inf leg was skipped


def test_decimal_nan_ingested_amount_does_not_crash_detector(handler, caplog):
    # A Decimal('NaN') repayment amount raised InvalidOperation inside is_repayment_credit's
    # `> 0` before PART B → the detector threw. Now skipped cleanly; a valid repayment in the
    # same page still alarms.
    rows = [_raw_amount_row(Decimal("NaN")), _raw_amount_row(Decimal("3573.00"))]
    text = _run(handler, caplog, rows=rows, push_amounts=[])
    assert _alarm_count(text) == 1
