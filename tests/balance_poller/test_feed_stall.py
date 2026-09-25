"""WHIT-606 — the balance poller's bank-feed stall push.

Replays the 22-25 Sept 2026 incident (BankSync sent only re-sends while the Westpac balance
kept moving) and pins the false-alarm guards: quiet days, an unchanged balance, re-sends,
deleted rows and the home loan never push; a genuinely new transaction resets the watch and,
after a stall push, sends the all-clear.
"""

from decimal import Decimal

import pytest

DAY = 24 * 60 * 60
NOW = 1_790_000_000
WESTPAC = "westpac-altitude-qantas-black"


class _FakeTransactionRepo:
    """Serves rows newest-first in pages, like the date-index query."""

    def __init__(self, rows_by_account, page_size=2):
        self.rows_by_account = rows_by_account
        self.page_size = page_size
        self.queried = []

    def get_transactions_by_date_range(self, account_id, start_date, end_date, limit, cursor=None):
        self.queried.append(account_id)
        rows = [r for r in self.rows_by_account.get(account_id, []) if r["date"] >= start_date]
        offset = cursor or 0
        page = rows[offset:offset + self.page_size]
        next_cursor = offset + self.page_size if offset + self.page_size < len(rows) else None
        return page, next_cursor


class _FakeWatchRepo:
    def __init__(self, watches=None):
        self.watches = dict(watches or {})
        self.puts = []

    def get_watch(self, account_id):
        watch = self.watches.get(account_id)
        return None if watch is None else {**watch, "seen_ids": set(watch["seen_ids"])}

    def put_watch(self, account_id, seen_ids, seen_at, amount_at_seen, alerted):
        self.puts.append(account_id)
        self.watches[account_id] = {
            "seen_ids": set(seen_ids), "seen_at": seen_at,
            "amount_at_seen": amount_at_seen, "alerted": alerted,
        }


class _FakeDeviceRepo:
    def __init__(self, tokens=("ExponentPushToken[x]",)):
        self.tokens = list(tokens)

    def list_tokens(self):
        return list(self.tokens)


def _row(transaction_id, date="2026-09-22", account_name="Altitude Qantas Black Card"):
    return {"transaction_id": transaction_id, "date": date, "account_name": account_name}


def _watch(seen_ids, seen_at, amount, alerted=False):
    return {"seen_ids": set(seen_ids), "seen_at": seen_at, "amount_at_seen": Decimal(amount),
            "alerted": alerted}


@pytest.fixture
def wired(handler, monkeypatch):
    """Wire the fakes into the handler and record every push."""
    pushes = []
    expo = {"accepts": True}

    def fake_send_push(title, body, tokens, data=None):
        if tokens:
            pushes.append((title, body, data))
        return {"sent": len(tokens), "ok": len(tokens) if expo["accepts"] else 0, "pruned": []}

    monkeypatch.setattr(handler, "send_push", fake_send_push)

    def wire(rows=None, watches=None, tokens=("ExponentPushToken[x]",), expo_accepts=True):
        expo["accepts"] = expo_accepts
        transaction_repo = _FakeTransactionRepo(rows or {})
        watch_repo = _FakeWatchRepo(watches)
        monkeypatch.setattr(handler, "TransactionRepository", lambda: transaction_repo)
        monkeypatch.setattr(handler, "FeedWatchRepository", lambda: watch_repo)
        monkeypatch.setattr(handler, "DeviceRepository", lambda: _FakeDeviceRepo(tokens))
        return transaction_repo, watch_repo

    return handler, wire, pushes


def _delta(account_id, new):
    return {"account_id": account_id, "old": None, "new": Decimal(new)}


def test_first_check_records_a_baseline_without_pushing(wired):
    handler, wire, pushes = wired
    _, watch_repo = wire(rows={WESTPAC: [_row("t1")]})

    handler.check_feed_stalls([_delta(WESTPAC, "-2992.75")], NOW)

    assert pushes == []
    assert watch_repo.watches[WESTPAC] == _watch({"t1"}, NOW, "-2992.75")


def test_incident_replay_resends_only_while_balance_moves_pushes_once(wired, caplog):
    # 22 Sept: last new rows. 23/24 Sept: only re-sends of those ids. Balance kept moving.
    handler, wire, pushes = wired
    _, watch_repo = wire(
        rows={WESTPAC: [_row("t1"), _row("t2")]},
        watches={WESTPAC: _watch({"t1", "t2"}, NOW - 3 * DAY, "-2992.75")},
    )

    handler.check_feed_stalls([_delta(WESTPAC, "-3232.56")], NOW)

    assert len(pushes) == 1
    title, body, data = pushes[0]
    assert "stopped" in title
    assert "Altitude Qantas Black Card" in body and "3 days" in body
    assert data == {"type": "feedstall", "account": WESTPAC}
    assert watch_repo.watches[WESTPAC]["alerted"] is True
    assert "TRANSACTION_FEED_STALLED account=westpac-altitude-qantas-black" in caplog.text


def test_an_ongoing_stall_pushes_only_once(wired):
    handler, wire, pushes = wired
    wire(
        rows={WESTPAC: [_row("t1")]},
        watches={WESTPAC: _watch({"t1"}, NOW - 5 * DAY, "-2992.75", alerted=True)},
    )

    handler.check_feed_stalls([_delta(WESTPAC, "-3300")], NOW)

    assert pushes == []


def test_stall_just_under_the_threshold_does_not_push(wired):
    handler, wire, pushes = wired
    wire(rows={WESTPAC: [_row("t1")]},
         watches={WESTPAC: _watch({"t1"}, NOW - 2 * DAY, "-2992.75")})

    handler.check_feed_stalls([_delta(WESTPAC, "-3232.56")], NOW)

    assert pushes == []


def test_three_daily_polls_that_start_a_little_early_still_push(wired):
    # Poll start times drift; three daily polls can land a few seconds short of 3 x 24h.
    handler, wire, pushes = wired
    wire(rows={WESTPAC: [_row("t1")]},
         watches={WESTPAC: _watch({"t1"}, NOW - 3 * DAY + 5, "-2992.75")})

    handler.check_feed_stalls([_delta(WESTPAC, "-3232.56")], NOW)

    assert len(pushes) == 1
    assert "3 days" in pushes[0][1]


def test_unchanged_balance_never_pushes(wired):
    # A quiet stretch (or an unused card like the ANZ at 0) is not a stall.
    handler, wire, pushes = wired
    wire(rows={"anz-rewards-black-visa": []},
         watches={"anz-rewards-black-visa": _watch(set(), NOW - 30 * DAY, "0")})

    handler.check_feed_stalls([_delta("anz-rewards-black-visa", "0")], NOW)

    assert pushes == []


def test_a_new_transaction_resets_the_watch(wired):
    handler, wire, pushes = wired
    _, watch_repo = wire(
        rows={WESTPAC: [_row("t3", "2026-09-19"), _row("t1")]},   # t3: a late, back-dated row
        watches={WESTPAC: _watch({"t1"}, NOW - 5 * DAY, "-2992.75")},
    )

    handler.check_feed_stalls([_delta(WESTPAC, "-3232.56")], NOW)

    assert pushes == []
    assert watch_repo.watches[WESTPAC] == _watch({"t1", "t3"}, NOW, "-3232.56")


def test_a_deleted_row_does_not_reset_the_watch(wired):
    # The age-out sweep or a settled pending removes a row mid-stall: no new id, still a stall.
    handler, wire, pushes = wired
    _, watch_repo = wire(
        rows={WESTPAC: [_row("t1")]},
        watches={WESTPAC: _watch({"t1", "t_deleted"}, NOW - 3 * DAY, "-2992.75")},
    )

    handler.check_feed_stalls([_delta(WESTPAC, "-3232.56")], NOW)

    assert len(pushes) == 1
    assert watch_repo.watches[WESTPAC]["seen_at"] == NOW - 3 * DAY


def test_no_activity_day_keeps_the_original_baseline(wired):
    handler, wire, pushes = wired
    _, watch_repo = wire(
        rows={WESTPAC: [_row("t1")]},
        watches={WESTPAC: _watch({"t1"}, NOW - DAY, "-2992.75")},
    )

    handler.check_feed_stalls([_delta(WESTPAC, "-3100")], NOW)

    assert watch_repo.puts == []


def test_recovery_after_a_stall_push_sends_the_all_clear(wired):
    handler, wire, pushes = wired
    _, watch_repo = wire(
        rows={WESTPAC: [_row("t9", "2026-09-25"), _row("t1")]},
        watches={WESTPAC: _watch({"t1"}, NOW - 4 * DAY, "-2992.75", alerted=True)},
    )

    handler.check_feed_stalls([_delta(WESTPAC, "-3300")], NOW)

    assert len(pushes) == 1
    assert "coming in again" in pushes[0][0]
    assert watch_repo.watches[WESTPAC]["alerted"] is False


def test_no_registered_device_retries_the_push_next_poll(wired):
    handler, wire, pushes = wired
    _, watch_repo = wire(
        rows={WESTPAC: [_row("t1")]},
        watches={WESTPAC: _watch({"t1"}, NOW - 3 * DAY, "-2992.75")},
        tokens=(),
    )

    handler.check_feed_stalls([_delta(WESTPAC, "-3232.56")], NOW)

    assert pushes == []
    assert watch_repo.watches[WESTPAC]["alerted"] is False


def test_a_push_expo_rejects_is_retried_next_poll(wired):
    handler, wire, pushes = wired
    _, watch_repo = wire(
        rows={WESTPAC: [_row("t1")]},
        watches={WESTPAC: _watch({"t1"}, NOW - 3 * DAY, "-2992.75")},
        expo_accepts=False,
    )

    handler.check_feed_stalls([_delta(WESTPAC, "-3232.56")], NOW)

    assert watch_repo.watches[WESTPAC]["alerted"] is False


def test_a_cursor_that_never_ends_fails_this_account_only(wired, caplog):
    handler, wire, pushes = wired
    transaction_repo, watch_repo = wire()
    transaction_repo.get_transactions_by_date_range = lambda *args: ([], "more")

    handler.check_feed_stalls([_delta(WESTPAC, "-1")], NOW)

    assert watch_repo.puts == []
    assert "did not finish" in caplog.text


def test_every_page_of_recent_ids_is_read(wired):
    # The fake serves 2 rows a page; the new id sits on the last page.
    handler, wire, pushes = wired
    rows = [_row("t1"), _row("t2"), _row("t3"), _row("t_new", "2026-09-20")]
    _, watch_repo = wire(rows={WESTPAC: rows},
                         watches={WESTPAC: _watch({"t1", "t2", "t3"}, NOW - 3 * DAY, "-1")})

    handler.check_feed_stalls([_delta(WESTPAC, "-2")], NOW)

    assert pushes == []
    assert "t_new" in watch_repo.watches[WESTPAC]["seen_ids"]


def test_home_loan_and_unpolled_accounts_are_skipped(wired):
    handler, wire, pushes = wired
    transaction_repo, watch_repo = wire()

    handler.check_feed_stalls([_delta("up-homeloan", "-594224.31")], NOW)

    assert transaction_repo.queried == []
    assert watch_repo.puts == []


def test_one_accounts_failure_does_not_stop_the_others(wired, handler):
    _, wire, pushes = wired
    transaction_repo, watch_repo = wire(
        rows={WESTPAC: [_row("t1")]},
        watches={WESTPAC: _watch({"t1"}, NOW - 3 * DAY, "-2992.75")},
    )
    real_query = transaction_repo.get_transactions_by_date_range

    def flaky(account_id, *args):
        if account_id == "up-spending":
            raise RuntimeError("throttled")
        return real_query(account_id, *args)

    transaction_repo.get_transactions_by_date_range = flaky

    handler.check_feed_stalls([_delta("up-spending", "5"), _delta(WESTPAC, "-3232.56")], NOW)

    assert len(pushes) == 1


def test_lambda_handler_swallows_a_feed_stall_failure(handler, monkeypatch):
    monkeypatch.setattr(handler, "get_api_key", lambda: "k")
    monkeypatch.setattr(handler, "_poll_homeloan", lambda api_key: True)
    monkeypatch.setattr(handler, "_poll_account_balances", lambda api_key: (1, []))
    monkeypatch.setattr(handler, "_check_goal_checkpoints", lambda deltas: None)

    def boom(deltas, now):
        raise RuntimeError("db down")

    monkeypatch.setattr(handler, "check_feed_stalls", boom)

    assert handler.lambda_handler({}, None) == {"homeloan_stored": True, "accounts_stored": 1}
