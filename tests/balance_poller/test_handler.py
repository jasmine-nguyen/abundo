"""Unit tests for the balance poller (lambda_balance_poller/handler.py).

Covers:
    - lambda_handler          : stores every signed balance; on ANY failure logs, does NOT raise,
                                does NOT zero a last-good row
    - _poll_account_balances  : the batched prior read feeding each account's old/new delta

No network and no AWS: ``urllib.request.urlopen`` is monkeypatched, boto3's ssm
client is faked by conftest, and the repository is replaced with a recording fake.
"""

import logging
import sys
from decimal import Decimal

import pytest

from _balance_fakes import balance_repo, homeloan_row, upserted
from _http_fakes import FakeResponse, http_error
from _milestone_fakes import FakeGoalsRepo


# --- helpers -----------------------------------------------------------------


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
_WESTPAC_PAYLOAD = {
    "success": True,
    "data": {
        "date": "2026-09-05T03:58:13.856Z", "accountName": "Altitude Qantas Black Card",
        "accountType": "unknown", "accountId": "A3AC9195-9E8D-48B8-86D0-46D130D7F64A",
        "amount": -230, "availableBalance": 5770, "currency": "AUD",
    },
}

# Every BALANCE_SOURCES aid -> its getBalance payload. Stubs look up through this
# dict rather than falling back to a default, so an aid with no payload raises
# instead of quietly resolving to another account's balance.
_PAYLOADS_BY_AID = {
    "3zVQJ8Btz_IRmqp78VrQnQ": _SPENDING_PAYLOAD,
    "T6d8ppsYssBDFCwl1qEb0w": _OK_PAYLOAD,
    "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0": _ANZ_PAYLOAD,
    "A3AC9195-9E8D-48B8-86D0-46D130D7F64A": _WESTPAC_PAYLOAD,
}


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


def test_lambda_handler_stores_homeloan_and_every_account_on_success(handler, monkeypatch, caplog):
    accounts = _FakeAccountRepo()
    monkeypatch.setattr(handler, "get_api_key", lambda: "the-key")
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: accounts)

    # Return a per-account payload keyed by the aid in the request URL. An aid with no
    # stub raises rather than falling through: _poll_account_balances swallows every
    # per-account exception, so a missing payload would otherwise leave this test green
    # while the account it names silently failed to store.
    def urlopen(req, timeout=None):
        for aid, payload in _PAYLOADS_BY_AID.items():
            if aid in req.full_url:
                return FakeResponse(payload)
        raise AssertionError(f"no stub payload for {req.full_url}")

    caplog.set_level(logging.ERROR)
    monkeypatch.setattr(handler.urllib.request, "urlopen", urlopen)

    result = handler.lambda_handler({}, None)

    assert result == {"accounts_stored": len(handler.BALANCE_SOURCES)}
    # The count alone can't prove every source stored — a swallowed per-account failure
    # lowers it silently. Assert the poller logged no skip at all.
    assert "account balance poll failed" not in caplog.text
    # A signed row per account, each under its internal id.
    stored = {c[0]: c[1] for c in accounts.calls}
    assert stored == {
        "up-spending": Decimal("96270.59"),
        "up-homeloan": Decimal("-596642.43"),
        "anz-rewards-black-visa": Decimal("-6492.26"),
        "westpac-altitude-qantas-black": Decimal("-230"),
    }


def test_lambda_handler_swallows_http_error_and_keeps_last_good(handler, monkeypatch):
    accounts = _FakeAccountRepo()
    monkeypatch.setattr(handler, "get_api_key", lambda: "the-key")
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: accounts)

    def boom(req, timeout=None):
        raise http_error(500)

    monkeypatch.setattr(handler.urllib.request, "urlopen", boom)

    # Never raises, never writes — every reader keeps serving its last-good row.
    result = handler.lambda_handler({}, None)
    assert result == {"accounts_stored": 0}
    assert accounts.calls == []


def test_lambda_handler_swallows_an_api_key_fetch_failure(handler, monkeypatch, caplog):
    # An SSM/get_param failure (throttle, missing param, IAM) must not error the
    # invocation — it's best-effort like the polls, so nothing is stored, nothing is
    # zeroed, and every last-good row survives.
    accounts = _FakeAccountRepo()

    def boom():
        raise RuntimeError("SSM throttled")

    monkeypatch.setattr(handler, "get_api_key", boom)
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: accounts)
    caplog.set_level(logging.INFO)

    result = handler.lambda_handler({}, None)
    assert result == {"accounts_stored": 0}
    assert accounts.calls == []
    # No heartbeat, or the balance-poll alarm would never page for it (WHIT-645).
    assert not any("BALANCE_POLL_ALL_STORED" in r.getMessage() for r in caplog.records)


def _mortgage(amount):
    return {"success": True,
            "data": {"amount": amount, "date": "2026-07-04T00:00:00Z", "accountType": "mortgage"}}


def _run(handler, monkeypatch, repo, payload):
    monkeypatch.setattr(handler, "get_api_key", lambda: "k")
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: repo)
    monkeypatch.setattr(handler.urllib.request, "urlopen", lambda req, timeout=None: FakeResponse(payload))
    return handler.lambda_handler({}, None)


def test_lambda_handler_stores_a_zero_balance_on_a_paid_off_loan(handler, monkeypatch):
    # A REAL 0 reading is written; only failure paths avoid zeroing.
    repo = balance_repo()
    monkeypatch.setattr(handler, "_check_homeloan", lambda deltas: None)
    _run(handler, monkeypatch, repo, _mortgage(0))
    assert upserted(repo)["up-homeloan"] == Decimal("0")


def test_lambda_handler_swallows_a_repository_upsert_failure(handler, monkeypatch):
    # The DynamoDB write failing must not raise out of the poller, and a balance that was never
    # stored must not celebrate a milestone crossing (WHIT-301).
    repo = balance_repo(rows=[homeloan_row("-600000", as_of="2026-07-03T00:00:00Z")], upsert_fails=True)
    detector_calls = []
    monkeypatch.setattr(sys.modules["milestones"], "notify_milestone_crossing",
                        lambda *args, **kwargs: detector_calls.append((args, kwargs)) or 0)

    result = _run(handler, monkeypatch, repo, _mortgage(-400000))

    assert result == {"accounts_stored": 0}
    assert upserted(repo)["up-homeloan"] == Decimal("-400000")  # attempted, then swallowed
    assert detector_calls == []


def test_poll_account_balances_batch_read_failure_degrades_old_but_still_stores(handler, monkeypatch):
    # WHIT-482: the batched prior read is best-effort AND load-bearing — list_balances re-raises a
    # DatabaseError, and lambda_handler doesn't guard this call, so an unswallowed failure would
    # abort the whole poll and store nothing. On failure every `old` is None but the poll still
    # upserts all balances. This reddens if the try/except is "simplified" away.
    accounts = _FakeAccountRepo(prior={"up-spending": Decimal("90000")}, list_raises=True)
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: accounts)
    monkeypatch.setattr(handler, "fetch_balance",
                        lambda bid, aid, key, **_: _PAYLOADS_BY_AID[aid])

    stored, deltas = handler._poll_account_balances("key")
    assert stored == len(handler.BALANCE_SOURCES)
    assert all(d["old"] is None for d in deltas)  # the failed read nulls every account's old
    assert len(accounts.calls) == len(handler.BALANCE_SOURCES)  # ...but every balance stored


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


@pytest.mark.parametrize(
    ("prior", "account_id", "expected_old"),
    [
        # A stored 0 is a real value; a `.get(id) or None` "cleanup" would null it (WHIT-482).
        ({"up-spending": Decimal("0")}, "up-spending", Decimal("0")),
        # A loan/credit-card prior stays NEGATIVE: not abs, not None.
        ({"up-homeloan": Decimal("-596000.00")}, "up-homeloan", Decimal("-596000.00")),
        # No prior row in the batch -> genuinely first poll -> None.
        ({}, "up-spending", None),
    ],
    ids=["zero", "negative", "missing"],
)
def test_poll_account_balances_negative_prior_keeps_signed_value(handler, monkeypatch, prior, account_id, expected_old):
    accounts = _FakeAccountRepo(prior=prior)
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: accounts)
    monkeypatch.setattr(handler, "fetch_balance", lambda bid, aid, key, **_: _PAYLOADS_BY_AID[aid])

    _stored, deltas = handler._poll_account_balances("key")

    by_account = {d["account_id"]: d for d in deltas}
    assert by_account[account_id]["old"] == expected_old


def test_poll_account_balances_partial_fetch_failure_survivors_keep_batched_old(handler, monkeypatch):
    # WHIT-482 — [A4] one account's fetch fails AFTER a successful batch read. The failed account is
    # dropped from the deltas; every surviving account still carries its OWN correct batched `old`
    # (not a shifted/None value). Extends the existing single-account-isolation test, which only
    # checks the stored count and ids, not that survivors keep the right prior.
    accounts = _FakeAccountRepo(
        prior={"up-spending": Decimal("90000"), "anz-rewards-black-visa": Decimal("-6000")}
    )
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: accounts)

    def fetch(bid, aid, key, **_):
        if aid == "T6d8ppsYssBDFCwl1qEb0w":  # mortgage fetch blows up
            raise RuntimeError("mortgage balance timed out")
        return _PAYLOADS_BY_AID[aid]

    monkeypatch.setattr(handler, "fetch_balance", fetch)

    stored, deltas = handler._poll_account_balances("key")
    by_account = {d["account_id"]: d for d in deltas}
    assert stored == len(handler.BALANCE_SOURCES) - 1
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
        lambda bid, aid, key, **_: _PAYLOADS_BY_AID[aid],
    )

    goal = {
        "direction": "grow", "name": "Holiday", "account_id": "up-spending",
        "checkpoints": [{"id": "cp1", "label": "Halfway", "amount": Decimal("95000")}],
    }
    notify_repo = _FakeNotifyRepo()
    monkeypatch.setattr(handler, "GoalsRepository", lambda: FakeGoalsRepo({"g1": goal}))
    monkeypatch.setattr(handler, "NotifyRepository", lambda: notify_repo)
    monkeypatch.setattr(handler, "DeviceRepository", lambda: _FakeDeviceRepo())
    sent = []
    monkeypatch.setattr(goal_checkpoints, "send_push",
                        lambda title, body, tokens, data=None: sent.append((title, data)))

    stored, deltas = handler._poll_account_balances("key")
    handler._check_goal_checkpoints(deltas)

    assert stored == len(handler.BALANCE_SOURCES)
    assert len(sent) == 1
    title, data = sent[0]
    assert "Halfway" in title
    assert data == {"type": "goalcheckpoint", "goalId": "g1"}
    # marked once-ever so the same crossing can't re-fire next poll.
    assert notify_repo.marked == ["g:g1:cp:cp1:bal:95000.00"]
