"""WHIT-317 GAP tests (adversarial) for the precise repayment-miss detector.

Complements tests/balance_poller/test_repayment_miss_precise.py — does NOT duplicate it.
Focus on the boundaries + failure surfaces the implementer's suite leaves open:
  - the $10 floor pinned exactly (and just below) at _is_repayment_credit's edge.
  - N repayments, some matched some not, in ONE call → alarm count == unmatched count.
  - odd-cent dollar→cent rounding matches an exact-cent marker.
  - the dropped pagination cursor: the detector reads ONE page (MAX_PAGE_SIZE) and
    ignores LastEvaluatedKey — documented so a future >100-row window can't silently
    regress unnoticed.
"""

import logging
from decimal import Decimal

MARKER = "UP_WEBHOOK_REPAYMENT_MISSED"
_DAY = 24 * 60 * 60
NOW = 1_800_000_000


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


def _run(handler, caplog, *, rows, push_amounts=(), notify=None, cursor=None):
    caplog.set_level(logging.ERROR)
    notify = notify or _FakeNotify(push_amounts)
    handler.check_ingested_repayment_without_push(notify, _FakeTxnRepo(rows, cursor), NOW)
    return caplog.text


def _alarm_count(text):
    return text.count(MARKER)


# --- [A22] the $10 floor pinned exactly at _is_repayment_credit's edge ------

def test_exactly_ten_dollars_is_a_qualifying_repayment(handler, caplog):
    # WHIT-317 — [A22] $10.00 == MIN_REPAYMENT_NOTIFY → NOT below the floor → alarms if
    # unpushed. Mirrors the webhook floor (valueInBaseUnits >= 1000).
    text = _run(handler, caplog, rows=[_row("10.00")], push_amounts=[])
    assert _alarm_count(text) == 1
    assert "1000 cents" in text


def test_just_below_ten_dollars_is_ignored(handler, caplog):
    # WHIT-317 — [A22] $9.99 < floor → not a repayment, no alarm even with zero pushes.
    text = _run(handler, caplog, rows=[_row("9.99")], push_amounts=[])
    assert MARKER not in text


# --- [A23] N repayments, mixed match/unmatch in ONE call --------------------

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


# --- [A24] odd-cent dollar->cent rounding matches an exact-cent marker -------

def test_odd_cent_amount_matches_its_cent_marker(handler, caplog):
    # $3,573.33 → 357333 cents (round, not truncate). A matching marker keeps it silent.
    text = _run(handler, caplog, rows=[_row("3573.33")], push_amounts=[357333])
    assert MARKER not in text


def test_odd_cent_amount_without_push_reports_exact_cents(handler, caplog):
    text = _run(handler, caplog, rows=[_row("3573.33")], push_amounts=[])
    assert "357333 cents" in text


# --- [A25] dropped pagination cursor: only ONE page is read -----------------

def test_detector_requests_max_page_size_and_ignores_the_cursor(handler, caplog):
    # The detector calls get_transactions_by_date_range with MAX_PAGE_SIZE and never
    # re-queries with the returned LastEvaluatedKey. This pins the single-page behaviour
    # so a >100-row 7-day window would silently drop the oldest repayments (see critique).
    repo = _FakeTxnRepo([_row("3573.00")], cursor={"pk": "more", "sk": "pages"})
    handler.check_ingested_repayment_without_push(_FakeNotify([357300]), repo, NOW)
    assert len(repo.calls) == 1  # cursor dropped: no second page fetched
    _account, _start, _end, limit = repo.calls[0]
    assert limit == handler.MAX_PAGE_SIZE
