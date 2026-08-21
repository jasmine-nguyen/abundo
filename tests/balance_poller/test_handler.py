"""Unit tests for the home-loan balance poller (lambda_balance_poller/handler.py).

Covers:
    - normalise_balance : sign handling (mortgage amount is negative -> abs),
                          field tolerance, and the failure guards (BalanceError)
    - fetch_balance     : the GET request shape (url, method, headers)
    - lambda_handler    : stores on success; on ANY failure logs, returns
                          {"stored": False}, does NOT raise, does NOT upsert

No network and no AWS: ``urllib.request.urlopen`` is monkeypatched, ``ssm`` is
faked by conftest, and the repository is replaced with a recording fake.
"""

import io
import json
import urllib.error
from decimal import Decimal

import pytest


# --- helpers -----------------------------------------------------------------


class _FakeResponse:
    """Stand-in for urlopen()'s return (used as a context manager; .read() -> bytes)."""

    def __init__(self, payload):
        self._body = json.dumps(payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self._body


# The real getBalance payload observed for the mortgage account (2026-07-04).
_OK_PAYLOAD = {
    "success": True,
    "data": {
        "date": "2026-07-04T00:24:37.614Z",
        "bank": "Up",
        "accountName": "🏠 Home loan",
        "accountType": "mortgage",
        "accountId": "T6d8ppsYssBDFCwl1qEb0w",
        "bankId": "fiskil_3",
        "amount": -596642.43,
        "availableBalance": 0,
        "pendingBalance": 0,
        "currency": "AUD",
    },
}


class _FakeRepo:
    """Recording stand-in for HomeLoanBalanceRepository. `prior` is what get_balance
    returns (the pre-upsert row) — None means nothing stored yet (first poll)."""

    def __init__(self, prior=None):
        self.calls = []
        self.prior = prior

    def get_balance(self, account_id):
        return self.prior

    def upsert_balance(self, account_id, balance, as_of, currency):
        self.calls.append((account_id, balance, as_of, currency))


class _FakeAccountRepo:
    """Recording stand-in for AccountBalanceRepository (signed per-account balances)."""

    def __init__(self, prior=None, list_raises=False):
        self.calls = []
        self.list_balance_calls = []  # ids passed to each list_balances call (WHIT-482 batching)
        self._prior = prior or {}  # {account_id: signed amount} read before the upsert (WHIT-479)
        self._list_raises = list_raises

    def list_balances(self, account_ids):
        self.list_balance_calls.append(list(account_ids))
        if self._list_raises:
            raise RuntimeError("dynamo throttle")
        return [{"account_id": a, "amount": self._prior[a]} for a in account_ids if a in self._prior]

    def upsert_balance(self, account_id, amount, available_balance, currency, as_of, account_type):
        self.calls.append((account_id, amount, available_balance, currency, as_of, account_type))


# Real getBalance payloads observed per account (2026-07-08).
_SPENDING_PAYLOAD = {
    "success": True,
    "data": {
        "date": "2026-07-08T09:32:02.405Z", "accountName": "Spending",
        "accountType": "checking", "accountId": "3zVQJ8Btz_IRmqp78VrQnQ",
        "amount": 96270.59, "availableBalance": 96270.59, "currency": "AUD",
    },
}
_ANZ_PAYLOAD = {
    "success": True,
    "data": {
        "date": "2026-07-08T09:32:37.337Z", "accountName": "ANZ Rewards Black Visa",
        "accountType": "unknown", "accountId": "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0",
        "amount": -6492.26, "availableBalance": 8171.88, "currency": "AUD",
    },
}


def _http_error(code):
    return urllib.error.HTTPError(
        url="https://api.banksync.io/x", code=code, msg="boom", hdrs=None, fp=io.BytesIO(b"")
    )


# --- normalise_balance -------------------------------------------------------


def test_normalise_balance_takes_absolute_value_of_negative_amount(handler):
    out = handler.normalise_balance(_OK_PAYLOAD)
    # The mortgage amount is -596642.43; the stored outstanding balance is positive.
    assert out == {
        "balance": Decimal("596642.43"),
        "as_of": "2026-07-04T00:24:37.614Z",
        "currency": "AUD",
    }


def test_normalise_balance_tolerates_missing_optional_fields(handler):
    # No availableBalance/pendingBalance, no accountType — still fine.
    payload = {"success": True, "data": {"amount": -400000, "date": "2026-07-04T00:00:00Z"}}
    out = handler.normalise_balance(payload)
    assert out["balance"] == Decimal("400000")
    assert out["currency"] == "AUD"  # defaulted when absent


def test_normalise_balance_raises_on_failure_response(handler):
    payload = {"success": False, "error": "Provider fiskil:au does not support loans"}
    with pytest.raises(handler.BalanceError):
        handler.normalise_balance(payload)


def test_normalise_balance_raises_on_missing_data(handler):
    with pytest.raises(handler.BalanceError):
        handler.normalise_balance({"success": True})


def test_normalise_balance_raises_on_missing_amount(handler):
    with pytest.raises(handler.BalanceError):
        handler.normalise_balance({"success": True, "data": {"date": "2026-07-04T00:00:00Z"}})


def test_normalise_balance_raises_on_missing_date(handler):
    with pytest.raises(handler.BalanceError):
        handler.normalise_balance({"success": True, "data": {"amount": -1}})


def test_normalise_balance_raises_on_non_mortgage_account(handler):
    payload = {"success": True, "data": {"amount": -1, "date": "d", "accountType": "transaction"}}
    with pytest.raises(handler.BalanceError):
        handler.normalise_balance(payload)


# --- fetch_balance -----------------------------------------------------------


def test_fetch_balance_builds_correct_get_request(handler, monkeypatch):
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["req"] = req
        captured["timeout"] = timeout
        return _FakeResponse(_OK_PAYLOAD)

    monkeypatch.setattr(handler.urllib.request, "urlopen", fake_urlopen)

    out = handler.fetch_balance("fiskil_3", "T6d8ppsYssBDFCwl1qEb0w", "the-key")

    req = captured["req"]
    assert req.method == "GET"
    assert req.full_url == "https://api.banksync.io/v1/banks/fiskil_3/accounts/T6d8ppsYssBDFCwl1qEb0w/balances"
    # urllib title-cases header keys, so "X-API-Key" is stored as "X-api-key".
    assert req.get_header("X-api-key") == "the-key"
    assert req.get_header("User-agent") == "abundo-homeloan-request"
    assert captured["timeout"] == handler.HOMELOAN_BALANCE_TIMEOUT_SECONDS
    assert out == _OK_PAYLOAD


# --- normalise_account_balance (WHIT-212) ------------------------------------


def test_normalise_account_balance_keeps_amount_signed_with_extras(handler):
    # The signed path keeps the NEGATIVE mortgage amount (no abs) and captures the extras.
    out = handler.normalise_account_balance(_OK_PAYLOAD)
    assert out == {
        "amount": Decimal("-596642.43"),
        "available_balance": Decimal("0"),
        "currency": "AUD",
        "as_of": "2026-07-04T00:24:37.614Z",
        "account_type": "mortgage",
    }


def test_normalise_account_balance_has_no_mortgage_guard(handler):
    # Unlike normalise_balance, a non-mortgage account normalises fine (positive spending).
    out = handler.normalise_account_balance(_SPENDING_PAYLOAD)
    assert out["amount"] == Decimal("96270.59")
    assert out["account_type"] == "checking"
    assert out["available_balance"] == Decimal("96270.59")


def test_normalise_account_balance_tolerates_missing_optionals(handler):
    payload = {"success": True, "data": {"amount": -6492.26, "date": "2026-07-08T00:00:00Z"}}
    out = handler.normalise_account_balance(payload)
    assert out["amount"] == Decimal("-6492.26")
    assert out["available_balance"] is None  # absent -> dropped, not fatal
    assert out["account_type"] is None
    assert out["currency"] == "AUD"  # defaulted


def test_normalise_account_balance_raises_on_failure_and_missing_fields(handler):
    for bad in (
        {"success": False, "error": "nope"},
        {"success": True},
        {"success": True, "data": {"date": "d"}},          # missing amount
        {"success": True, "data": {"amount": -1}},          # missing date
    ):
        with pytest.raises(handler.BalanceError):
            handler.normalise_account_balance(bad)


# --- get_api_key -------------------------------------------------------------


def test_get_api_key_reads_the_banksync_path(handler, monkeypatch):
    # The wrapper must hand the BankSync key path to the shared fetch (WHIT-454).
    # Caching itself is covered in tests/shared/test_api_key.py.
    import api_key
    calls = []
    monkeypatch.setattr(api_key, "get_param", lambda path: calls.append(path) or "k")
    assert handler.get_api_key() == "k"
    assert calls == [handler.BANKSYNC_API_KEY_PATH]


# --- lambda_handler ----------------------------------------------------------


def test_lambda_handler_stores_homeloan_and_every_account_on_success(handler, monkeypatch):
    homeloan = _FakeRepo()
    accounts = _FakeAccountRepo()
    monkeypatch.setattr(handler, "get_api_key", lambda: "the-key")
    monkeypatch.setattr(handler, "HomeLoanBalanceRepository", lambda: homeloan)
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: accounts)

    # Return a per-account payload keyed by the aid in the request URL.
    payloads = {
        "3zVQJ8Btz_IRmqp78VrQnQ": _SPENDING_PAYLOAD,
        "T6d8ppsYssBDFCwl1qEb0w": _OK_PAYLOAD,
        "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0": _ANZ_PAYLOAD,
    }
    monkeypatch.setattr(handler.urllib.request, "urlopen",
                        lambda req, timeout=None: _FakeResponse(next(p for aid, p in payloads.items() if aid in req.full_url)))

    result = handler.lambda_handler({}, None)

    assert result == {"homeloan_stored": True, "accounts_stored": 3}
    # The abs home-loan row (Goal screen) is still written exactly as before.
    assert homeloan.calls == [("up-homeloan", Decimal("596642.43"), "2026-07-04T00:24:37.614Z", "AUD")]
    # A signed row per account, each under its internal id.
    stored = {c[0]: c[1] for c in accounts.calls}
    assert stored == {
        "up-spending": Decimal("96270.59"),
        "up-homeloan": Decimal("-596642.43"),
        "anz-rewards-black-visa": Decimal("-6492.26"),
    }


def test_lambda_handler_swallows_http_error_and_keeps_last_good(handler, monkeypatch):
    homeloan = _FakeRepo()
    accounts = _FakeAccountRepo()
    monkeypatch.setattr(handler, "get_api_key", lambda: "the-key")
    monkeypatch.setattr(handler, "HomeLoanBalanceRepository", lambda: homeloan)
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: accounts)

    def boom(req, timeout=None):
        raise _http_error(500)

    monkeypatch.setattr(handler.urllib.request, "urlopen", boom)

    # Never raises, never writes — every reader keeps serving its last-good row.
    result = handler.lambda_handler({}, None)
    assert result == {"homeloan_stored": False, "accounts_stored": 0}
    assert homeloan.calls == []
    assert accounts.calls == []


def test_lambda_handler_swallows_failure_payload_without_writing(handler, monkeypatch):
    homeloan = _FakeRepo()
    accounts = _FakeAccountRepo()
    monkeypatch.setattr(handler, "get_api_key", lambda: "the-key")
    monkeypatch.setattr(handler, "HomeLoanBalanceRepository", lambda: homeloan)
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: accounts)
    fail = {"success": False, "error": "Provider fiskil:au does not support loans"}
    monkeypatch.setattr(handler.urllib.request, "urlopen", lambda req, timeout=None: _FakeResponse(fail))

    result = handler.lambda_handler({}, None)
    assert result == {"homeloan_stored": False, "accounts_stored": 0}
    assert homeloan.calls == []
    assert accounts.calls == []


def test_lambda_handler_swallows_an_api_key_fetch_failure(handler, monkeypatch):
    # An SSM/get_param failure (throttle, missing param, IAM) must not error the
    # invocation — it's best-effort like the polls, so nothing is stored, nothing is
    # zeroed, and every last-good row survives.
    homeloan = _FakeRepo()
    accounts = _FakeAccountRepo()

    def boom():
        raise RuntimeError("SSM throttled")

    monkeypatch.setattr(handler, "get_api_key", boom)
    monkeypatch.setattr(handler, "HomeLoanBalanceRepository", lambda: homeloan)
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: accounts)

    result = handler.lambda_handler({}, None)
    assert result == {"homeloan_stored": False, "accounts_stored": 0}
    assert homeloan.calls == []
    assert accounts.calls == []


def test_poll_account_balances_isolates_a_single_account_failure(handler, monkeypatch):
    # One account's poll blows up; the others must still store (best-effort per account).
    accounts = _FakeAccountRepo()
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: accounts)

    def fetch(bid, aid, api_key):
        if aid == "T6d8ppsYssBDFCwl1qEb0w":
            raise RuntimeError("mortgage balance timed out")
        return _SPENDING_PAYLOAD if aid == "3zVQJ8Btz_IRmqp78VrQnQ" else _ANZ_PAYLOAD

    monkeypatch.setattr(handler, "fetch_balance", fetch)

    stored, _deltas = handler._poll_account_balances("the-key")

    assert stored == 2  # spending + anz stored; the mortgage poll was skipped
    ids = {c[0] for c in accounts.calls}
    assert ids == {"up-spending", "anz-rewards-black-visa"}


# --- WHIT-301: milestone celebration hook in _poll_homeloan ------------------

def test_poll_homeloan_calls_milestone_detector_with_old_then_new(handler, monkeypatch):
    """Reads the pre-upsert balance and passes (old, new) to the detector after storing."""
    fake = _FakeRepo(prior={"balance": Decimal("600000"), "as_of": "x", "currency": "AUD"})
    monkeypatch.setattr(handler, "HomeLoanBalanceRepository", lambda: fake)
    monkeypatch.setattr(handler, "fetch_balance", lambda *a, **k: _OK_PAYLOAD)
    seen = {}
    monkeypatch.setattr(handler, "notify_milestone_crossing",
                        lambda old, new, **kw: seen.update(old=old, new=new) or 1)

    assert handler._poll_homeloan("key") is True
    assert seen["old"] == Decimal("600000")            # the pre-upsert (last-good) balance
    assert seen["new"] == Decimal("596642.43")         # the freshly-polled balance
    assert fake.calls == [("up-homeloan", Decimal("596642.43"), "2026-07-04T00:24:37.614Z", "AUD")]


def test_poll_homeloan_first_poll_passes_none_as_old(handler, monkeypatch):
    fake = _FakeRepo(prior=None)  # nothing stored yet
    monkeypatch.setattr(handler, "HomeLoanBalanceRepository", lambda: fake)
    monkeypatch.setattr(handler, "fetch_balance", lambda *a, **k: _OK_PAYLOAD)
    seen = {}
    monkeypatch.setattr(handler, "notify_milestone_crossing",
                        lambda old, new, **kw: seen.update(old=old, new=new) or 0)

    handler._poll_homeloan("key")
    assert seen["old"] is None


def test_poll_homeloan_milestone_failure_is_swallowed_balance_still_stored(handler, monkeypatch):
    """Best-effort: a milestone-push failure must never flip the stored-balance result."""
    fake = _FakeRepo(prior={"balance": Decimal("600000"), "as_of": "x", "currency": "AUD"})
    monkeypatch.setattr(handler, "HomeLoanBalanceRepository", lambda: fake)
    monkeypatch.setattr(handler, "fetch_balance", lambda *a, **k: _OK_PAYLOAD)

    def boom(*a, **k):
        raise RuntimeError("expo down")

    monkeypatch.setattr(handler, "notify_milestone_crossing", boom)

    assert handler._poll_homeloan("key") is True  # balance still stored despite the failure
    assert fake.calls == [("up-homeloan", Decimal("596642.43"), "2026-07-04T00:24:37.614Z", "AUD")]


# --- WHIT-479: goal-checkpoint celebration hook in the account poll -----------

class _FakeGoalsRepo:
    def __init__(self, goals):
        self._goals = goals  # {goal_id: goal}

    def list_goals(self):
        return dict(self._goals)


def test_poll_account_balances_returns_old_new_deltas(handler, monkeypatch):
    # A prior stored balance for spending; anz has none (first poll → old None).
    accounts = _FakeAccountRepo(prior={"up-spending": Decimal("90000")})
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: accounts)
    monkeypatch.setattr(handler, "fetch_balance",
                        lambda bid, aid, key: _SPENDING_PAYLOAD if aid == "3zVQJ8Btz_IRmqp78VrQnQ" else _ANZ_PAYLOAD)

    stored, deltas = handler._poll_account_balances("key")
    assert stored == 3
    by_account = {d["account_id"]: d for d in deltas}
    assert by_account["up-spending"]["old"] == Decimal("90000")
    assert by_account["up-spending"]["new"] == Decimal("96270.59")
    assert by_account["anz-rewards-black-visa"]["old"] is None  # first poll → seed guard


def test_poll_account_balances_reads_prior_balances_in_one_batch(handler, monkeypatch):
    # WHIT-482: the prior read is hoisted out of the per-account loop. Whatever the account count,
    # there is exactly ONE list_balances call, for the whole mapped id set — so this reddens if the
    # read ever moves back inside the loop (that would make one call per account).
    accounts = _FakeAccountRepo(prior={"up-spending": Decimal("90000")})
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: accounts)
    monkeypatch.setattr(handler, "fetch_balance",
                        lambda bid, aid, key: _SPENDING_PAYLOAD if aid == "3zVQJ8Btz_IRmqp78VrQnQ" else _ANZ_PAYLOAD)

    handler._poll_account_balances("key")
    assert len(accounts.list_balance_calls) == 1
    assert accounts.list_balance_calls[0] == sorted(set(handler.ACCOUNT_ID_MAP.values()))


def test_poll_account_balances_batch_read_failure_degrades_old_but_still_stores(handler, monkeypatch):
    # WHIT-482: the batched prior read is best-effort AND load-bearing — list_balances re-raises a
    # DatabaseError, and lambda_handler doesn't guard this call, so an unswallowed failure would
    # abort the whole poll and store nothing. On failure every `old` is None but the poll still
    # upserts all balances. This reddens if the try/except is "simplified" away.
    accounts = _FakeAccountRepo(prior={"up-spending": Decimal("90000")}, list_raises=True)
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: accounts)
    monkeypatch.setattr(handler, "fetch_balance",
                        lambda bid, aid, key: _SPENDING_PAYLOAD if aid == "3zVQJ8Btz_IRmqp78VrQnQ" else _ANZ_PAYLOAD)

    stored, deltas = handler._poll_account_balances("key")
    assert stored == 3
    assert all(d["old"] is None for d in deltas)  # the failed read nulls every account's old
    assert len(accounts.calls) == 3               # ...but every balance was still stored


def test_check_goal_checkpoints_fires_for_a_synced_goal_whose_account_crossed(handler, monkeypatch):
    goal = {"direction": "grow", "name": "Holiday", "account_id": "up-spending",
            "checkpoints": [{"id": "cp1", "label": "Halfway", "amount": Decimal("95000")}]}
    monkeypatch.setattr(handler, "GoalsRepository", lambda: _FakeGoalsRepo({"g1": goal}))
    monkeypatch.setattr(handler, "NotifyRepository", lambda: object())
    monkeypatch.setattr(handler, "DeviceRepository", lambda: object())
    seen = []
    monkeypatch.setattr(handler, "notify_goal_checkpoint_crossing",
                        lambda old, new, **kw: seen.append((old, new, kw["goal_id"], kw["synced"])) or 1)

    handler._check_goal_checkpoints([{"account_id": "up-spending", "old": Decimal("90000"), "new": Decimal("96270.59")}])
    assert seen == [(Decimal("90000"), Decimal("96270.59"), "g1", True)]


def test_check_goal_checkpoints_skips_manual_goals_and_unpolled_accounts(handler, monkeypatch):
    goals = {
        "manual1": {"direction": "grow", "account_id": None, "manual_balance": Decimal("5000"), "checkpoints": []},
        "unpolled": {"direction": "grow", "account_id": "anz-rewards-black-visa", "checkpoints": []},
    }
    monkeypatch.setattr(handler, "GoalsRepository", lambda: _FakeGoalsRepo(goals))
    monkeypatch.setattr(handler, "NotifyRepository", lambda: object())
    monkeypatch.setattr(handler, "DeviceRepository", lambda: object())
    seen = []
    monkeypatch.setattr(handler, "notify_goal_checkpoint_crossing", lambda old, new, **kw: seen.append(kw["goal_id"]) or 0)

    # deltas only has up-spending; neither goal matches (one manual, one on an unpolled account).
    handler._check_goal_checkpoints([{"account_id": "up-spending", "old": Decimal("1"), "new": Decimal("2")}])
    assert seen == []


def test_check_goal_checkpoints_one_goals_error_does_not_sink_the_others(handler, monkeypatch):
    # g1 raises (a transient DB hiccup); g2 also crossed this poll and MUST still be attempted —
    # otherwise next poll its `old` is already past the rung and its celebration is lost forever.
    goals = {
        "g1": {"direction": "grow", "name": "A", "account_id": "up-spending", "checkpoints": []},
        "g2": {"direction": "grow", "name": "B", "account_id": "anz-rewards-black-visa", "checkpoints": []},
    }
    monkeypatch.setattr(handler, "GoalsRepository", lambda: _FakeGoalsRepo(goals))
    monkeypatch.setattr(handler, "NotifyRepository", lambda: object())
    monkeypatch.setattr(handler, "DeviceRepository", lambda: object())
    seen = []

    def crossing(old, new, **kw):
        seen.append(kw["goal_id"])
        if kw["goal_id"] == "g1":
            raise RuntimeError("dynamo throttle")
        return 1

    monkeypatch.setattr(handler, "notify_goal_checkpoint_crossing", crossing)
    handler._check_goal_checkpoints([
        {"account_id": "up-spending", "old": Decimal("1"), "new": Decimal("2")},
        {"account_id": "anz-rewards-black-visa", "old": Decimal("1"), "new": Decimal("2")},
    ])
    assert seen == ["g1", "g2"]  # g1 raised, but g2 was still attempted


def test_lambda_handler_passes_account_deltas_to_the_goal_checkpoint_check(handler, monkeypatch):
    monkeypatch.setattr(handler, "get_api_key", lambda: "key")
    monkeypatch.setattr(handler, "_poll_homeloan", lambda key: True)
    deltas = [{"account_id": "up-spending", "old": Decimal("1"), "new": Decimal("2")}]
    monkeypatch.setattr(handler, "_poll_account_balances", lambda key: (2, deltas))
    seen = {}
    monkeypatch.setattr(handler, "_check_goal_checkpoints", lambda d: seen.update(deltas=d))

    result = handler.lambda_handler({}, None)
    assert result == {"homeloan_stored": True, "accounts_stored": 2}
    assert seen["deltas"] == deltas


def test_lambda_handler_goal_checkpoint_failure_is_swallowed(handler, monkeypatch):
    monkeypatch.setattr(handler, "get_api_key", lambda: "key")
    monkeypatch.setattr(handler, "_poll_homeloan", lambda key: True)
    monkeypatch.setattr(handler, "_poll_account_balances", lambda key: (2, []))
    def boom(_deltas):
        raise RuntimeError("expo down")
    monkeypatch.setattr(handler, "_check_goal_checkpoints", boom)

    # A push failure must not flip the stored-balance result.
    assert handler.lambda_handler({}, None) == {"homeloan_stored": True, "accounts_stored": 2}


# --- WHIT-482 (QA additions): batched prior-read gaps -------------------------
# Card: WHIT-482 — hoist the per-account prior-balance read into one batched read.
# These cover gaps the 3 existing/new cases leave open. They exercise the REAL
# handler._poll_account_balances / _check_goal_checkpoints — no re-implemented math.


class _FakeNotifyRepo:
    """Records fired goal-checkpoint markers; starts with none fired."""

    def __init__(self):
        self.marked = []

    def fired_goal_checkpoints(self, scope=None):
        return set()

    def mark_goal_checkpoint_fired(self, marker, scope=None):
        self.marked.append(marker)


class _FakeDeviceRepo:
    def list_tokens(self):
        return ["ExponentPushToken[x]"]


def test_poll_account_balances_zero_prior_keeps_signed_zero_not_none(handler, monkeypatch):
    # WHIT-482 — [A1] a stored prior of exactly 0 must reach the delta as Decimal("0"), NOT None.
    # `.get()` returns 0 as a real value; a `.get(id) or None` "cleanup" would wrongly null it and
    # a checkpoint sitting just above 0 would never celebrate. Guards that regression.
    accounts = _FakeAccountRepo(prior={"up-spending": Decimal("0"), "up-homeloan": Decimal("0")})
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: accounts)
    monkeypatch.setattr(
        handler, "fetch_balance",
        lambda bid, aid, key: {
            "3zVQJ8Btz_IRmqp78VrQnQ": _SPENDING_PAYLOAD,
            "T6d8ppsYssBDFCwl1qEb0w": _OK_PAYLOAD,
            "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0": _ANZ_PAYLOAD,
        }[aid],
    )

    _stored, deltas = handler._poll_account_balances("key")
    by_account = {d["account_id"]: d for d in deltas}
    assert by_account["up-spending"]["old"] == Decimal("0")
    assert by_account["up-spending"]["old"] is not None
    assert by_account["up-homeloan"]["old"] == Decimal("0")


def test_poll_account_balances_negative_prior_keeps_signed_value(handler, monkeypatch):
    # WHIT-482 — [A2] a synced loan/credit-card prior is stored NEGATIVE. The delta's `old` must be
    # that exact signed value (not abs, not None), so paydown checkpoints normalise correctly.
    accounts = _FakeAccountRepo(
        prior={"up-homeloan": Decimal("-596000.00"), "anz-rewards-black-visa": Decimal("-6000.00")}
    )
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: accounts)
    monkeypatch.setattr(
        handler, "fetch_balance",
        lambda bid, aid, key: {
            "3zVQJ8Btz_IRmqp78VrQnQ": _SPENDING_PAYLOAD,
            "T6d8ppsYssBDFCwl1qEb0w": _OK_PAYLOAD,
            "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0": _ANZ_PAYLOAD,
        }[aid],
    )

    _stored, deltas = handler._poll_account_balances("key")
    by_account = {d["account_id"]: d for d in deltas}
    assert by_account["up-homeloan"]["old"] == Decimal("-596000.00")
    assert by_account["anz-rewards-black-visa"]["old"] == Decimal("-6000.00")
    # up-spending had no prior row in the batch -> genuinely first poll -> None.
    assert by_account["up-spending"]["old"] is None


def test_poll_account_balances_extra_prior_ids_are_harmless_and_dont_leak(handler, monkeypatch):
    # WHIT-482 — [A3] the batch may return MORE ids than the loop visits (an account mapped/stored
    # but not in BALANCE_SOURCES, or simply extra rows). Those must NEVER surface as a delta —
    # deltas come from the BALANCE_SOURCES loop, not prior_by_id — and must not disturb real olds.
    accounts = _FakeAccountRepo(
        prior={"up-spending": Decimal("90000"), "orphan-not-a-source": Decimal("777")}
    )
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: accounts)
    monkeypatch.setattr(
        handler, "fetch_balance",
        lambda bid, aid, key: _SPENDING_PAYLOAD if aid == "3zVQJ8Btz_IRmqp78VrQnQ" else _ANZ_PAYLOAD,
    )

    stored, deltas = handler._poll_account_balances("key")
    account_ids = {d["account_id"] for d in deltas}
    assert stored == 3
    assert "orphan-not-a-source" not in account_ids  # the extra row never leaks into a delta
    by_account = {d["account_id"]: d for d in deltas}
    assert by_account["up-spending"]["old"] == Decimal("90000")  # real old undisturbed by the extra


def test_poll_account_balances_partial_fetch_failure_survivors_keep_batched_old(handler, monkeypatch):
    # WHIT-482 — [A4] one account's fetch fails AFTER a successful batch read. The failed account is
    # dropped from the deltas; every surviving account still carries its OWN correct batched `old`
    # (not a shifted/None value). Extends the existing single-account-isolation test, which only
    # checks the stored count and ids, not that survivors keep the right prior.
    accounts = _FakeAccountRepo(
        prior={"up-spending": Decimal("90000"), "anz-rewards-black-visa": Decimal("-6000")}
    )
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: accounts)

    def fetch(bid, aid, key):
        if aid == "T6d8ppsYssBDFCwl1qEb0w":  # mortgage fetch blows up
            raise RuntimeError("mortgage balance timed out")
        return _SPENDING_PAYLOAD if aid == "3zVQJ8Btz_IRmqp78VrQnQ" else _ANZ_PAYLOAD

    monkeypatch.setattr(handler, "fetch_balance", fetch)

    stored, deltas = handler._poll_account_balances("key")
    by_account = {d["account_id"]: d for d in deltas}
    assert stored == 2
    assert "up-homeloan" not in by_account  # the failed account is skipped from deltas
    assert by_account["up-spending"]["old"] == Decimal("90000")     # survivor keeps its own old
    assert by_account["anz-rewards-black-visa"]["old"] == Decimal("-6000")


def test_batched_delta_drives_a_real_goal_checkpoint_crossing_end_to_end(handler, monkeypatch):
    # WHIT-482 — [A5] end-to-end: a batched prior read -> delta.old -> a REAL checkpoint crossing.
    # up-spending's batched prior (90000) sits below the checkpoint (95000); the fresh poll
    # (96270.59) crosses it. Runs the real notify_goal_checkpoint_crossing/crossed_checkpoints —
    # only send_push is stubbed. Reddens if the prior read stops feeding `old` (old->None => seed
    # guard => no push).
    import goal_checkpoints

    accounts = _FakeAccountRepo(prior={"up-spending": Decimal("90000")})
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: accounts)
    monkeypatch.setattr(
        handler, "fetch_balance",
        lambda bid, aid, key: _SPENDING_PAYLOAD if aid == "3zVQJ8Btz_IRmqp78VrQnQ" else _ANZ_PAYLOAD,
    )

    goal = {
        "direction": "grow", "name": "Holiday", "account_id": "up-spending",
        "checkpoints": [{"id": "cp1", "label": "Halfway", "amount": Decimal("95000")}],
    }
    notify_repo = _FakeNotifyRepo()
    monkeypatch.setattr(handler, "GoalsRepository", lambda: _FakeGoalsRepo({"g1": goal}))
    monkeypatch.setattr(handler, "NotifyRepository", lambda: notify_repo)
    monkeypatch.setattr(handler, "DeviceRepository", lambda: _FakeDeviceRepo())
    sent = []
    monkeypatch.setattr(goal_checkpoints, "send_push",
                        lambda title, body, tokens, data=None: sent.append((title, data)))

    stored, deltas = handler._poll_account_balances("key")
    handler._check_goal_checkpoints(deltas)

    assert stored == 3
    assert len(sent) == 1
    title, data = sent[0]
    assert "Halfway" in title
    assert data == {"type": "goalcheckpoint", "goalId": "g1"}
    # marked once-ever so the same crossing can't re-fire next poll.
    assert notify_repo.marked == ["g:g1:cp:cp1:bal:95000.00"]
