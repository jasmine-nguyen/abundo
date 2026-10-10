"""Unit tests for the scheduled BankSync sync-trigger Lambda.

Covers the three functions in ``lambda_sync_trigger/handler.py``:
    - get_api_key   : delegates to the shared per-container key cache
    - trigger_sync  : the per-feed POST, incl. the 409 "already running" skip
    - lambda_handler: per-feed failure isolation + final RuntimeError

No network and no AWS: ``urllib.request.urlopen`` is monkeypatched and boto3's ssm
client is faked by conftest.py. See conftest.py for why the import setup lives there.
"""

import urllib.error

import handler
import pytest

from _http_fakes import FakeResponse, http_error


# --- helpers -----------------------------------------------------------------


def _ok_response(job_id="job-123"):
    return FakeResponse({"data": {"id": job_id}})


@pytest.fixture(autouse=True)
def _reset_api_key_cache():
    """Clear the shared api-key cache around each test so the fetch test is
    deterministic (the cache now lives in shared/api_key.py — WHIT-454)."""
    import api_key
    api_key._cache.clear()
    yield
    api_key._cache.clear()


@pytest.fixture(autouse=True)
def _no_pending_mirror(monkeypatch):
    """Stub the WHIT-662 pending mirror so the urlopen fakes here only see the sync POSTs.
    The mirror itself is covered in test_pending_mirror.py."""
    monkeypatch.setattr(handler.pending_mirror, "mirror_pendings", lambda api_key: None)


# --- get_api_key -------------------------------------------------------------


def test_get_api_key_reads_the_banksync_path(monkeypatch):
    # The wrapper delegates to the shared cache with the BankSync path. Caching
    # itself is covered in tests/shared/test_api_key.py.
    import api_key
    calls = []
    monkeypatch.setattr(api_key, "get_param", lambda path: calls.append(path) or "secret")

    assert handler.get_api_key() == "secret"
    assert calls == [handler.BANKSYNC_API_KEY_PATH]


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
    assert req.get_method() == "POST"
    assert req.full_url == "https://api.banksync.io/v1/feeds/feed-1/sync"
    assert req.data == b""  # empty body => incremental sync
    # urllib title-cases header keys, so "X-API-Key" is stored as "X-api-key".
    assert req.get_header("X-api-key") == "the-key"
    assert req.get_header("User-agent") == "abundo-transaction-trigger"
    assert captured["timeout"] == handler.SYNC_TIMEOUT_SECONDS






# --- lambda_handler ----------------------------------------------------------




def test_lambda_handler_all_feeds_succeed(monkeypatch):
    monkeypatch.setattr(handler, "get_api_key", lambda: "the-key")
    calls = []

    def fake_urlopen(req, timeout=None):
        calls.append(req.full_url)
        return _ok_response()

    monkeypatch.setattr(handler.urllib.request, "urlopen", fake_urlopen)

    result = handler.lambda_handler({}, None)

    assert result == {"triggered": list(handler.SYNC_FEED_IDS)}
    assert len(calls) == len(handler.SYNC_FEED_IDS)  # one POST per feed


def test_lambda_handler_isolates_per_feed_failure(monkeypatch):
    monkeypatch.setattr(handler, "get_api_key", lambda: "the-key")
    feed_ids = list(handler.SYNC_FEED_IDS)
    calls = []

    def fake_urlopen(req, timeout=None):
        calls.append(req.full_url)
        # Fail the first feed, succeed the second — proves the loop keeps going.
        if feed_ids[0] in req.full_url:
            raise http_error(500)
        return _ok_response()

    monkeypatch.setattr(handler.urllib.request, "urlopen", fake_urlopen)

    with pytest.raises(RuntimeError) as excinfo:
        handler.lambda_handler({}, None)

    assert feed_ids[0] in str(excinfo.value)  # message names the failed feed
    assert len(calls) == len(handler.SYNC_FEED_IDS)  # second feed still attempted


def test_lambda_handler_all_409_is_not_a_failure(monkeypatch):
    monkeypatch.setattr(handler, "get_api_key", lambda: "the-key")

    def fake_urlopen(req, timeout=None):
        raise http_error(409)

    monkeypatch.setattr(handler.urllib.request, "urlopen", fake_urlopen)

    # Every feed already syncing => all skipped => normal return, no RuntimeError.
    result = handler.lambda_handler({}, None)
    assert result == {"triggered": list(handler.SYNC_FEED_IDS)}


def test_lambda_handler_url_error_counts_as_failure(monkeypatch):
    monkeypatch.setattr(handler, "get_api_key", lambda: "the-key")

    def fake_urlopen(req, timeout=None):
        # A timeout/DNS failure is a URLError, not HTTPError, so trigger_sync does
        # not swallow it; lambda_handler's broad except must catch it as a failure.
        raise urllib.error.URLError("timeout")

    monkeypatch.setattr(handler.urllib.request, "urlopen", fake_urlopen)

    with pytest.raises(RuntimeError):
        handler.lambda_handler({}, None)


# --- WHIT-644: a rejected key fails the run and is re-read next hour ----------


def test_rejected_key_fails_the_run_and_next_run_uses_the_newly_saved_key(monkeypatch):
    # 28 Sep: BankSync rejected our key (401) on every feed. The run must fail (that
    # is what the Errors alarm counts), and once Jas saves a new key to SSM the next
    # hourly run in the same warm container must use it, not the cached old one.
    import api_key
    ssm = {"value": "old-key"}
    monkeypatch.setattr(api_key, "get_param", lambda path: ssm["value"])

    seen_keys = []

    def rejecting_urlopen(req, timeout=None):
        seen_keys.append(req.get_header("X-api-key"))
        raise http_error(401)

    monkeypatch.setattr(handler.urllib.request, "urlopen", rejecting_urlopen)
    with pytest.raises(RuntimeError):
        handler.lambda_handler({}, None)

    ssm["value"] = "new-key"
    accepted_keys = []

    def accepting_urlopen(req, timeout=None):
        accepted_keys.append(req.get_header("X-api-key"))
        return _ok_response()

    monkeypatch.setattr(handler.urllib.request, "urlopen", accepting_urlopen)
    assert handler.lambda_handler({}, None) == {"triggered": list(handler.SYNC_FEED_IDS)}

    assert set(seen_keys) == {"old-key"}
    assert accepted_keys and set(accepted_keys) == {"new-key"}


# --- WHIT-662: the pending mirror runs after the syncs and never fails the run ----


def test_pending_mirror_runs_after_every_sync_post(monkeypatch):
    monkeypatch.setattr(handler, "get_api_key", lambda: "the-key")
    events = []

    def fake_urlopen(req, timeout=None):
        events.append("post")
        return _ok_response()

    monkeypatch.setattr(handler.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(handler.pending_mirror, "mirror_pendings", lambda api_key: events.append(("mirror", api_key)))

    handler.lambda_handler({}, None)

    assert events == ["post"] * len(handler.SYNC_FEED_IDS) + [("mirror", "the-key")]


def test_a_pending_mirror_failure_still_triggers_every_feed_and_does_not_raise(monkeypatch):
    monkeypatch.setattr(handler, "get_api_key", lambda: "the-key")
    calls = []

    def fake_urlopen(req, timeout=None):
        calls.append(req.full_url)
        return _ok_response()

    def broken_mirror(api_key):
        raise RuntimeError("mirror broke")

    monkeypatch.setattr(handler.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(handler.pending_mirror, "mirror_pendings", broken_mirror)

    assert handler.lambda_handler({}, None) == {"triggered": list(handler.SYNC_FEED_IDS)}
    assert len(calls) == len(handler.SYNC_FEED_IDS)


def test_a_pending_mirror_failure_does_not_hide_a_failed_feed(monkeypatch):
    monkeypatch.setattr(handler, "get_api_key", lambda: "the-key")

    def fake_urlopen(req, timeout=None):
        raise http_error(500)

    def broken_mirror(api_key):
        raise RuntimeError("mirror broke")

    monkeypatch.setattr(handler.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(handler.pending_mirror, "mirror_pendings", broken_mirror)

    with pytest.raises(RuntimeError, match="sync trigger failed"):
        handler.lambda_handler({}, None)


def test_the_mirror_still_runs_when_every_feed_fails(monkeypatch):
    # A failed sync POST must not stop the mirror (it runs before the final raise), and
    # the run still raises for the WHIT-644 alarm.
    monkeypatch.setattr(handler, "get_api_key", lambda: "the-key")
    monkeypatch.setattr(handler, "forget_api_key", lambda path: None)

    def urlopen(req, timeout=None):
        raise http_error(500)

    monkeypatch.setattr(handler.urllib.request, "urlopen", urlopen)
    calls = []
    monkeypatch.setattr(handler.pending_mirror, "mirror_pendings", lambda api_key: calls.append(api_key))

    with pytest.raises(RuntimeError, match="sync trigger failed"):
        handler.lambda_handler({}, None)
    assert calls == ["the-key"]
