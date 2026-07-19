"""Unit tests for the scheduled BankSync sync-trigger Lambda.

Covers the three functions in ``lambda_sync_trigger/handler.py``:
    - get_api_key   : SSM fetch + per-container caching
    - trigger_sync  : the per-feed POST, incl. the 409 "already running" skip
    - lambda_handler: per-feed failure isolation + final RuntimeError

No network and no AWS: ``urllib.request.urlopen`` is monkeypatched and ``ssm`` is
faked by conftest.py. See conftest.py for why the import setup lives there.
"""

import io
import json
import urllib.error

import handler
import pytest


# --- helpers -----------------------------------------------------------------


class _FakeResponse:
    """Stand-in for the object urllib returns from urlopen().

    The handler uses it as a context manager (``with urlopen(...) as resp``) and
    calls ``resp.read()``, expecting bytes of JSON shaped {"data": {"id": ...}}.
    """

    def __init__(self, payload):
        self._body = json.dumps(payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self._body


def _ok_response(job_id="job-123"):
    return _FakeResponse({"data": {"id": job_id}})


def _http_error(code):
    """Build a urllib HTTPError with a given status code (e.g. 409, 500)."""
    return urllib.error.HTTPError(
        url="https://api.banksync.io/v1/feeds/x/sync",
        code=code,
        msg="boom",
        hdrs=None,
        fp=io.BytesIO(b""),
    )


@pytest.fixture(autouse=True)
def _reset_api_key_cache(monkeypatch):
    """Clear the module-global api-key cache before each test so caching tests
    are deterministic. monkeypatch auto-restores after the test."""
    monkeypatch.setattr(handler, "_api_key", None)


# --- get_api_key -------------------------------------------------------------


def test_get_api_key_fetches_from_ssm(monkeypatch):
    calls = []
    monkeypatch.setattr(handler, "get_param", lambda path: calls.append(path) or "secret")

    assert handler.get_api_key() == "secret"
    assert calls == [handler.BANKSYNC_API_KEY_PATH]


def test_get_api_key_is_cached(monkeypatch):
    calls = []
    monkeypatch.setattr(handler, "get_param", lambda path: calls.append(path) or "secret")

    handler.get_api_key()
    handler.get_api_key()

    # Second call must hit the cache, not SSM again.
    assert len(calls) == 1


# --- trigger_sync ------------------------------------------------------------


def test_trigger_sync_happy_path_builds_correct_request(monkeypatch):
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["req"] = req
        captured["timeout"] = timeout
        return _ok_response()

    monkeypatch.setattr(handler.urllib.request, "urlopen", fake_urlopen)

    handler.trigger_sync("feed-1", "the-key")

    req = captured["req"]
    assert req.method == "POST"
    assert req.full_url == "https://api.banksync.io/v1/feeds/feed-1/sync"
    assert req.data == b""  # empty body => incremental sync
    # urllib title-cases header keys, so "X-API-Key" is stored as "X-api-key".
    assert req.get_header("X-api-key") == "the-key"
    assert req.get_header("User-agent") == "abundo-transaction-trigger"
    assert captured["timeout"] == handler.SYNC_TIMEOUT_SECONDS


def test_trigger_sync_409_is_skipped(monkeypatch):
    def fake_urlopen(req, timeout=None):
        raise _http_error(409)

    monkeypatch.setattr(handler.urllib.request, "urlopen", fake_urlopen)

    # 409 = a sync is already running; the handler swallows it and returns None.
    assert handler.trigger_sync("feed-1", "the-key") is None


def test_trigger_sync_non_409_http_error_is_raised(monkeypatch):
    def fake_urlopen(req, timeout=None):
        raise _http_error(500)

    monkeypatch.setattr(handler.urllib.request, "urlopen", fake_urlopen)

    with pytest.raises(urllib.error.HTTPError):
        handler.trigger_sync("feed-1", "the-key")


# --- lambda_handler ----------------------------------------------------------


def test_lambda_handler_all_feeds_succeed(monkeypatch):
    monkeypatch.setattr(handler, "get_param", lambda path: "the-key")
    calls = []

    def fake_urlopen(req, timeout=None):
        calls.append(req.full_url)
        return _ok_response()

    monkeypatch.setattr(handler.urllib.request, "urlopen", fake_urlopen)

    result = handler.lambda_handler({}, None)

    assert result == {"triggered": list(handler.SYNC_FEED_IDS)}
    assert len(calls) == len(handler.SYNC_FEED_IDS)  # one POST per feed


def test_lambda_handler_isolates_per_feed_failure(monkeypatch):
    monkeypatch.setattr(handler, "get_param", lambda path: "the-key")
    feed_ids = list(handler.SYNC_FEED_IDS)
    calls = []

    def fake_urlopen(req, timeout=None):
        calls.append(req.full_url)
        # Fail the first feed, succeed the second — proves the loop keeps going.
        if feed_ids[0] in req.full_url:
            raise _http_error(500)
        return _ok_response()

    monkeypatch.setattr(handler.urllib.request, "urlopen", fake_urlopen)

    with pytest.raises(RuntimeError) as excinfo:
        handler.lambda_handler({}, None)

    assert feed_ids[0] in str(excinfo.value)  # message names the failed feed
    assert len(calls) == len(handler.SYNC_FEED_IDS)  # second feed still attempted


def test_lambda_handler_all_409_is_not_a_failure(monkeypatch):
    monkeypatch.setattr(handler, "get_param", lambda path: "the-key")

    def fake_urlopen(req, timeout=None):
        raise _http_error(409)

    monkeypatch.setattr(handler.urllib.request, "urlopen", fake_urlopen)

    # Every feed already syncing => all skipped => normal return, no RuntimeError.
    result = handler.lambda_handler({}, None)
    assert result == {"triggered": list(handler.SYNC_FEED_IDS)}


def test_lambda_handler_url_error_counts_as_failure(monkeypatch):
    monkeypatch.setattr(handler, "get_param", lambda path: "the-key")

    def fake_urlopen(req, timeout=None):
        # A timeout/DNS failure is a URLError, not HTTPError, so trigger_sync does
        # not swallow it; lambda_handler's broad except must catch it as a failure.
        raise urllib.error.URLError("timeout")

    monkeypatch.setattr(handler.urllib.request, "urlopen", fake_urlopen)

    with pytest.raises(RuntimeError):
        handler.lambda_handler({}, None)
