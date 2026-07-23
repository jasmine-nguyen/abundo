"""Tests for the missed-repayment alarm backstop (WHIT-316).

`check_repayment_landed_but_no_push` logs `UP_WEBHOOK_REPAYMENT_MISSED` (which a
CloudWatch alarm watches) when the mortgage balance dropped like a repayment landed but
no push fired within the lookback window. Unit-tests the branch matrix directly, then
confirms `_poll_homeloan` calls it with (old, new) and swallows a failure.
"""

import logging
import time
from decimal import Decimal

MARKER = "UP_WEBHOOK_REPAYMENT_MISSED"
_DAY = 24 * 60 * 60


class _FakeNotify:
    def __init__(self, last_fired_at=None):
        self._last_fired_at = last_fired_at

    def last_repayment_fired_at(self):
        return self._last_fired_at


def _check(handler, caplog, *, old, new, last_fired_at):
    caplog.set_level(logging.ERROR)
    handler.check_repayment_landed_but_no_push(old, new, _FakeNotify(last_fired_at))
    return MARKER in caplog.text


# --- the branch matrix -----------------------------------------------------

def test_drop_with_no_recorded_push_alarms(handler, caplog):
    assert _check(handler, caplog, old=Decimal("600000"), new=Decimal("596000"), last_fired_at=None)


def test_drop_with_stale_push_alarms(handler, caplog):
    stale = int(time.time()) - 30 * _DAY
    assert _check(handler, caplog, old=Decimal("600000"), new=Decimal("596000"), last_fired_at=stale)


def test_drop_with_recent_push_is_silent(handler, caplog):
    recent = int(time.time()) - 1 * _DAY
    assert not _check(handler, caplog, old=Decimal("600000"), new=Decimal("596000"), last_fired_at=recent)


def test_small_drop_is_silent(handler, caplog):
    # $1,000 drop < the $3,000 threshold.
    assert not _check(handler, caplog, old=Decimal("600000"), new=Decimal("599000"), last_fired_at=None)


def test_no_prior_balance_is_silent(handler, caplog):
    assert not _check(handler, caplog, old=None, new=Decimal("596000"), last_fired_at=None)


def test_balance_rose_is_silent(handler, caplog):
    # Interest / redraw raises the balance — never a repayment, never an alarm.
    assert not _check(handler, caplog, old=Decimal("600000"), new=Decimal("604000"), last_fired_at=None)


def test_zero_drop_is_silent(handler, caplog):
    # A second poll after a drop day sees old == new → no re-alarm; also the deploy
    # transition where the drop was already stored before this check shipped.
    assert not _check(handler, caplog, old=Decimal("596000"), new=Decimal("596000"), last_fired_at=None)


def test_boundary_exactly_threshold_alarms(handler, caplog):
    # Exactly $3,000 counts (>= threshold).
    assert _check(handler, caplog, old=Decimal("599000"), new=Decimal("596000"), last_fired_at=None)


# --- integration with _poll_homeloan --------------------------------------

class _FakeBalanceRepo:
    def __init__(self, prior):
        self.prior = prior

    def get_balance(self, account_id):
        return self.prior

    def upsert_balance(self, *args):
        pass


def _wire_successful_poll(handler, monkeypatch, prior):
    monkeypatch.setattr(handler, "HomeLoanBalanceRepository", lambda: _FakeBalanceRepo(prior))
    monkeypatch.setattr(handler, "fetch_balance", lambda *a, **k: {
        "success": True,
        "data": {"amount": -596000, "date": "2026-07-04T00:00:00Z", "accountType": "mortgage"},
    })
    monkeypatch.setattr(handler, "notify_milestone_crossing", lambda *a, **k: None)
    monkeypatch.setattr(handler, "NotifyRepository", lambda: _FakeNotify())


def test_poll_calls_check_with_old_and_new(handler, monkeypatch):
    _wire_successful_poll(handler, monkeypatch, prior={"balance": Decimal("600000"), "as_of": "x", "currency": "AUD"})
    calls = []
    monkeypatch.setattr(handler, "check_repayment_landed_but_no_push",
                        lambda old, new, notify_repo: calls.append((old, new)))
    assert handler._poll_homeloan("key") is True
    assert calls == [(Decimal("600000"), Decimal("596000"))]


def test_poll_swallows_a_check_failure(handler, monkeypatch):
    _wire_successful_poll(handler, monkeypatch, prior={"balance": Decimal("600000"), "as_of": "x", "currency": "AUD"})

    def _raise(*a, **k):
        raise RuntimeError("check blew up")

    monkeypatch.setattr(handler, "check_repayment_landed_but_no_push", _raise)
    # The balance was still stored, so the poll succeeds despite the check failing.
    assert handler._poll_homeloan("key") is True


# --- integration: the precise detector (WHIT-317) --------------------------

def test_poll_runs_the_precise_detector(handler, monkeypatch):
    _wire_successful_poll(handler, monkeypatch, prior={"balance": Decimal("600000"), "as_of": "x", "currency": "AUD"})
    monkeypatch.setattr(handler, "TransactionRepository", lambda: object())
    monkeypatch.setattr(handler, "check_repayment_landed_but_no_push", lambda *a, **k: None)
    calls = []
    monkeypatch.setattr(handler, "check_ingested_repayment_without_push",
                        lambda notify_repo, txn_repo, now: calls.append(now))
    assert handler._poll_homeloan("key") is True
    assert len(calls) == 1  # ran once


def test_poll_swallows_a_precise_detector_failure(handler, monkeypatch):
    _wire_successful_poll(handler, monkeypatch, prior={"balance": Decimal("600000"), "as_of": "x", "currency": "AUD"})
    monkeypatch.setattr(handler, "TransactionRepository", lambda: object())
    monkeypatch.setattr(handler, "check_ingested_repayment_without_push", _raise_detector)
    # The balance was still stored, so the poll succeeds despite the detector failing.
    assert handler._poll_homeloan("key") is True


def test_precise_detector_runs_even_when_balance_fetch_fails(handler, monkeypatch):
    # The detector reads only DynamoDB, so a getBalance outage (poll returns False) must not
    # blind it — it runs before the fetch.
    monkeypatch.setattr(handler, "fetch_balance", _raise_detector)
    monkeypatch.setattr(handler, "NotifyRepository", lambda: _FakeNotify())
    monkeypatch.setattr(handler, "TransactionRepository", lambda: object())
    calls = []
    monkeypatch.setattr(handler, "check_ingested_repayment_without_push",
                        lambda notify_repo, txn_repo, now: calls.append(now))
    assert handler._poll_homeloan("key") is False  # balance poll failed
    assert len(calls) == 1  # but the detector still ran


def _raise_detector(*a, **k):
    raise RuntimeError("detector blew up")
