"""WHIT-618 QA: adversarial checks on the Up home-loan lookup.

urlopen is faked at the network boundary; the real fetch_transaction,
get_homeloan_account_id and repayment_skip_reason run.
"""

import hashlib
import hmac
import json
import logging
import socket
import urllib.error
import urllib.parse

import pytest

from _dynamo_fakes import FakeTable

MOCK_SECRET = "mock-secret"
OLD_HOMELOAN_ID = "fbef6cbc-09b3-4b6f-826c-6a178707a178"
NEW_HOMELOAN_ID = "9f9f9f9f-renumbered-loan"
SIGNATURE_KEY = "x-up-authenticity-signature"
ACCOUNTS_MARKER = "/accounts"


class _FakeHTTPResponse:
    def __init__(self, payload):
        self._body = json.dumps(payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self._body


class _FakeDevice:
    def list_tokens(self):
        return ["ExponentPushToken[abc]"]


def _accounts(*home_loan_ids):
    data = [{"id": "spending", "type": "accounts",
             "attributes": {"accountType": "TRANSACTIONAL"}},
            {"id": "saver", "type": "accounts",
             "attributes": {"accountType": "SAVER"}}]
    data += [{"id": account_id, "type": "accounts",
              "attributes": {"accountType": "HOME_LOAN"}} for account_id in home_loan_ids]
    return {"data": data}


def _transaction(transaction_id, account_id, cents=357300):
    return {
        "id": transaction_id,
        "attributes": {"amount": {"valueInBaseUnits": cents}},
        "relationships": {"account": {"data": {"id": account_id}}},
    }


def _event(transaction_id):
    payload = {"data": {
        "attributes": {"eventType": "TRANSACTION_CREATED"},
        "relationships": {"transaction": {"data": {"id": transaction_id}}},
    }}
    raw = json.dumps(payload).encode("utf-8")
    signature = hmac.new(MOCK_SECRET.encode("utf-8"), raw, hashlib.sha256).hexdigest()
    return {"body": raw.decode("utf-8"), "isBase64Encoded": False,
            "headers": {SIGNATURE_KEY: signature}}


def _markers(caplog, marker):
    return [r for r in caplog.records if marker in r.getMessage().split()]


def _http_error(code):
    return urllib.error.HTTPError("https://api.up.com.au/x", code, "nope", {}, None)


@pytest.fixture(autouse=True)
def _no_real_ssm(lam, monkeypatch):
    monkeypatch.setattr(lam.up_webhook, "get_param", lambda path: "fake-secret")


@pytest.fixture
def lookup(lam, monkeypatch):
    """The real lookup with a scriptable urlopen. `script` is a list of responses
    (dict → JSON body, Exception → raised) consumed one per accounts call."""
    up = lam.up_webhook
    monkeypatch.setattr(up, "get_personal_access_token", lambda: "up-token")
    state = type("Lookup", (), {"up": up, "script": [], "requests": [], "timeouts": []})

    def fake_urlopen(request, timeout=None):
        state.requests.append(request)
        state.timeouts.append(timeout)
        response = state.script.pop(0)
        if isinstance(response, Exception):
            raise response
        return _FakeHTTPResponse(response)

    monkeypatch.setattr(up.urllib.request, "urlopen", fake_urlopen)
    return state


@pytest.fixture
def handler(lam, monkeypatch):
    """The real handler, fetch and lookup; urlopen serves transactions from `transactions`
    and the accounts list from `accounts` (dict or Exception)."""
    up = lam.up_webhook
    monkeypatch.setattr(up, "get_signing_secret", lambda: MOCK_SECRET)
    monkeypatch.setattr(up, "_personal_access_token", "up-token")
    notify = up.NotifyRepository()
    notify._table = FakeTable()
    monkeypatch.setattr(up, "NotifyRepository", lambda: notify)
    monkeypatch.setattr(up, "DeviceRepository", lambda: _FakeDevice())
    state = type("Handler", (), {"up": up, "sent": [], "transactions": {},
                                 "accounts": _accounts(NEW_HOMELOAN_ID), "account_calls": 0})

    def fake_send_push(title, body, tokens, data=None):
        state.sent.append(title)
        return {"sent": len(tokens), "ok": 1, "pruned": []}

    def fake_urlopen(request, timeout=None):
        url = request.full_url
        if "/transactions/" in url:
            return _FakeHTTPResponse({"data": state.transactions[url.rsplit("/", 1)[-1]]})
        assert ACCOUNTS_MARKER in url
        state.account_calls += 1
        if isinstance(state.accounts, Exception):
            raise state.accounts
        return _FakeHTTPResponse(state.accounts)

    monkeypatch.setattr(up, "send_push", fake_send_push)
    monkeypatch.setattr(up.urllib.request, "urlopen", fake_urlopen)
    return state


# --- get_homeloan_account_id ---------------------------------------------

# [A1]
def test_request_asks_up_for_home_loan_accounts_with_bearer_and_timeout(lookup):
    lookup.script = [_accounts(NEW_HOMELOAN_ID)]
    lookup.up.get_homeloan_account_id()
    [request] = lookup.requests
    parsed = urllib.parse.urlsplit(request.full_url)
    assert (parsed.scheme, parsed.netloc, parsed.path) == ("https", "api.up.com.au",
                                                           "/api/v1/accounts")
    assert urllib.parse.parse_qs(parsed.query) == {"filter[accountType]": ["HOME_LOAN"]}
    assert request.get_header("Authorization") == "Bearer up-token"
    assert lookup.timeouts == [lookup.up.UP_FETCH_TIMEOUT_SECONDS]


# [A2]
def test_picks_the_single_home_loan_among_other_account_types(lookup):
    lookup.script = [_accounts(NEW_HOMELOAN_ID)]
    assert lookup.up.get_homeloan_account_id() == NEW_HOMELOAN_ID


# [A3]
def test_entries_of_other_types_are_ignored_even_if_up_ignores_the_filter(lookup):
    # Up returns only non-loan accounts → none_found, not "spending".
    lookup.script = [_accounts()]
    assert lookup.up.get_homeloan_account_id() == OLD_HOMELOAN_ID


# [A4]
@pytest.mark.parametrize("error", [_http_error(500), _http_error(429), _http_error(401),
                                   urllib.error.URLError("refused"), TimeoutError(),
                                   socket.timeout("timed out")],
                         ids=["500", "429", "401", "urlerror", "timeout", "socket_timeout"])
def test_network_failures_fall_back_logged_and_unsaved(lookup, caplog, error):
    lookup.script = [error, _accounts(NEW_HOMELOAN_ID)]
    caplog.set_level(logging.INFO)
    assert lookup.up.get_homeloan_account_id() == OLD_HOMELOAN_ID
    [record] = _markers(caplog, "UP_WEBHOOK_HOMELOAN_LOOKUP_FALLBACK")
    assert record.levelno == logging.WARNING
    assert "reason=lookup_failed" in record.getMessage().split()
    # Not saved: the next call asks Up again and gets the real answer.
    assert lookup.up.get_homeloan_account_id() == NEW_HOMELOAN_ID
    assert len(lookup.requests) == 2


# [A5]
def test_lookup_401_does_not_clear_the_cached_token(lam, monkeypatch):
    up = lam.up_webhook
    monkeypatch.setattr(up, "_personal_access_token", "cached-token")

    def fake_urlopen(request, timeout=None):
        raise _http_error(401)

    monkeypatch.setattr(up.urllib.request, "urlopen", fake_urlopen)
    assert up.get_homeloan_account_id() == OLD_HOMELOAN_ID
    assert up._personal_access_token == "cached-token"


# [A6]
@pytest.mark.parametrize("body", [{"data": None}, {"data": [{"id": "x", "attributes": {}}]},
                                  {"data": [{"attributes": {"accountType": "HOME_LOAN"}}]}],
                         ids=["data_null", "no_account_type", "no_id"])
def test_malformed_body_falls_back_unsaved(lookup, caplog, body):
    lookup.script = [body, _accounts(NEW_HOMELOAN_ID)]
    caplog.set_level(logging.INFO)
    assert lookup.up.get_homeloan_account_id() == OLD_HOMELOAN_ID
    [record] = _markers(caplog, "UP_WEBHOOK_HOMELOAN_LOOKUP_FALLBACK")
    assert "reason=lookup_failed" in record.getMessage().split()
    assert lookup.up.get_homeloan_account_id() == NEW_HOMELOAN_ID


# [A7]
def test_non_json_body_falls_back(lam, monkeypatch, caplog):
    up = lam.up_webhook
    monkeypatch.setattr(up, "get_personal_access_token", lambda: "up-token")

    class _Html(_FakeHTTPResponse):
        def read(self):
            return b"<html>maintenance</html>"

    monkeypatch.setattr(up.urllib.request, "urlopen", lambda request, timeout=None: _Html({}))
    caplog.set_level(logging.INFO)
    assert up.get_homeloan_account_id() == OLD_HOMELOAN_ID
    assert _markers(caplog, "UP_WEBHOOK_HOMELOAN_LOOKUP_FALLBACK")


# [A8]
@pytest.mark.parametrize("ids,reason,count", [((), "none_found", "0"),
                                              (("a", "b"), "several_found", "2"),
                                              (("a", "b", "c"), "several_found", "3")])
def test_wrong_count_logs_reason_and_count_and_is_not_saved(lookup, caplog, ids, reason, count):
    lookup.script = [_accounts(*ids), _accounts(NEW_HOMELOAN_ID)]
    caplog.set_level(logging.INFO)
    assert lookup.up.get_homeloan_account_id() == OLD_HOMELOAN_ID
    [record] = _markers(caplog, "UP_WEBHOOK_HOMELOAN_LOOKUP_FALLBACK")
    words = record.getMessage().split()
    assert f"reason={reason}" in words
    assert f"count={count}" in words
    assert lookup.up.get_homeloan_account_id() == NEW_HOMELOAN_ID


# [A9]
def test_same_id_as_fixed_is_saved_without_id_changed_log(lookup, caplog):
    lookup.script = [_accounts(OLD_HOMELOAN_ID)]
    caplog.set_level(logging.INFO)
    assert lookup.up.get_homeloan_account_id() == OLD_HOMELOAN_ID
    assert lookup.up.get_homeloan_account_id() == OLD_HOMELOAN_ID
    assert len(lookup.requests) == 1
    assert not _markers(caplog, "UP_WEBHOOK_HOMELOAN_ID_CHANGED")
    assert not _markers(caplog, "UP_WEBHOOK_HOMELOAN_LOOKUP_FALLBACK")


# [A10]
def test_id_changed_logged_once_with_the_new_id(lookup, caplog):
    lookup.script = [_accounts(NEW_HOMELOAN_ID)]
    caplog.set_level(logging.INFO)
    lookup.up.get_homeloan_account_id()
    lookup.up.get_homeloan_account_id()
    [record] = _markers(caplog, "UP_WEBHOOK_HOMELOAN_ID_CHANGED")
    assert f"account={NEW_HOMELOAN_ID}" in record.getMessage().split()


# --- repayment_skip_reason ----------------------------------------------

# [A11]
@pytest.mark.parametrize("cents", [999, 0, -234828])
def test_sub_floor_never_triggers_the_lookup(lam, monkeypatch, cents):
    up = lam.up_webhook
    calls = []
    monkeypatch.setattr(up, "get_homeloan_account_id", lambda: calls.append(1) or OLD_HOMELOAN_ID)
    assert up.repayment_skip_reason(_transaction("t", "anything", cents)) == "below_floor"
    assert calls == []


# [A12]
def test_skip_reason_uses_the_looked_up_id_not_the_constant(lam, monkeypatch):
    up = lam.up_webhook
    monkeypatch.setattr(up, "get_homeloan_account_id", lambda: NEW_HOMELOAN_ID)
    assert up.repayment_skip_reason(_transaction("t", NEW_HOMELOAN_ID)) is None
    assert up.repayment_skip_reason(_transaction("t", OLD_HOMELOAN_ID)) == "not_homeloan_account"


# --- through the handler ------------------------------------------------

# [A13]
def test_warm_container_asks_up_for_accounts_only_once(handler):
    handler.transactions = {"t1": _transaction("t1", NEW_HOMELOAN_ID),
                            "t2": _transaction("t2", NEW_HOMELOAN_ID)}
    up = handler.up
    assert up.lambda_handler(_event("t1"), None) == up.OK_RESPONSE
    assert up.lambda_handler(_event("t2"), None) == up.OK_RESPONSE
    assert len(handler.sent) == 2
    assert handler.account_calls == 1


# [A14]
def test_sub_floor_and_interest_on_renumbered_loan_send_nothing_and_skip_lookup(handler, caplog):
    handler.transactions = {"small": _transaction("small", NEW_HOMELOAN_ID, 500),
                            "interest": _transaction("interest", NEW_HOMELOAN_ID, -234828)}
    up = handler.up
    caplog.set_level(logging.INFO)
    assert up.lambda_handler(_event("small"), None) == up.OK_RESPONSE
    assert up.lambda_handler(_event("interest"), None) == up.OK_RESPONSE
    assert handler.sent == []
    assert handler.account_calls == 0
    assert len([r for r in _markers(caplog, "UP_WEBHOOK_SKIP")
                if "reason=below_floor" in r.getMessage().split()]) == 2


# [A15]
def test_lookup_failure_on_a_non_loan_account_skips_without_500(handler, caplog):
    handler.accounts = _http_error(503)
    handler.transactions = {"t": _transaction("t", "spending")}
    up = handler.up
    caplog.set_level(logging.INFO)
    assert up.lambda_handler(_event("t"), None) == up.OK_RESPONSE
    assert handler.sent == []
    assert "reason=not_homeloan_account transaction=t account=spending" in caplog.text


# [A16]
def test_ambiguous_lookup_still_pushes_on_the_fixed_id(handler):
    handler.accounts = _accounts("loan-a", "loan-b")
    handler.transactions = {"t": _transaction("t", OLD_HOMELOAN_ID)}
    up = handler.up
    assert up.lambda_handler(_event("t"), None) == up.OK_RESPONSE
    assert len(handler.sent) == 1


# [A17]
def test_renumbered_repayment_is_deduped_on_up_retry(handler):
    handler.transactions = {"t": _transaction("t", NEW_HOMELOAN_ID)}
    up = handler.up
    assert up.lambda_handler(_event("t"), None) == up.OK_RESPONSE
    assert up.lambda_handler(_event("t"), None) == up.OK_RESPONSE
    assert len(handler.sent) == 1
