"""WHIT-490 — the third BankSync feed in the scheduled sync trigger.

tests/sync_trigger/test_handler.py already covers the generic loop (happy path,
409 skip, all-409, per-feed isolation on the FIRST feed, URLError). These add the
edges that only appear once a THIRD feed exists, and lock the claim written into
shared/constants.py next to the new id: the Westpac feed also runs BankSync's own
daily schedule, so our hourly tick can overlap it and get a 409 — which must stay
a harmless skip while the remaining feeds still sync.
"""

import io
import json
import urllib.error

import handler

_WESTPAC_FEED = "zJiG0SNKKWScMp9bFdD4"


class _FakeResponse:
    def __init__(self, payload):
        self._body = json.dumps(payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self._body


def _ok(job_id="job-123"):
    return _FakeResponse({"data": {"id": job_id}})


def _http_error(code):
    return urllib.error.HTTPError(url="https://api.banksync.io/v1/feeds/x/sync",
                                  code=code, msg="boom", hdrs=None, fp=io.BytesIO(b""))


# --- the feed is actually wired ----------------------------------------------


def test_westpac_feed_is_triggered_by_its_own_url(monkeypatch):
    # The card's whole point: the new feed gets its own POST. Asserted on the URL,
    # not on a count, so dropping the id from SYNC_FEED_IDS reddens even if some other
    # feed were added at the same time.
    monkeypatch.setattr(handler, "get_api_key", lambda: "the-key")
    urls = []
    monkeypatch.setattr(handler.urllib.request, "urlopen",
                        lambda req, timeout=None: urls.append(req.full_url) or _ok())

    result = handler.lambda_handler({}, None)

    assert f"https://api.banksync.io/v1/feeds/{_WESTPAC_FEED}/sync" in urls
    assert _WESTPAC_FEED in result["triggered"]
    assert handler.SYNC_FEED_IDS[_WESTPAC_FEED] == "westpac-altitude-qantas-black"


# --- the documented overlap with BankSync's own daily schedule ---------------


def test_westpac_409_overlap_is_a_skip_and_the_other_feeds_still_sync(monkeypatch):
    # Only the Westpac feed 409s (BankSync's own daily job is mid-flight). The
    # invocation must SUCCEED — no RuntimeError, no alarm — and every other feed must
    # still have been POSTed. The existing all-409 test can't catch a regression that
    # turned a partial 409 into a hard failure, because there is no survivor in it.
    assert _WESTPAC_FEED in handler.SYNC_FEED_IDS  # can't pass vacuously if the feed vanishes
    monkeypatch.setattr(handler, "get_api_key", lambda: "the-key")
    urls = []

    def urlopen(req, timeout=None):
        urls.append(req.full_url)
        if _WESTPAC_FEED in req.full_url:
            raise _http_error(409)
        return _ok()

    monkeypatch.setattr(handler.urllib.request, "urlopen", urlopen)

    result = handler.lambda_handler({}, None)

    assert result == {"triggered": list(handler.SYNC_FEED_IDS)}
    assert len(urls) == len(handler.SYNC_FEED_IDS)
    others = [f for f in handler.SYNC_FEED_IDS if f != _WESTPAC_FEED]
    assert all(any(f in u for u in urls) for f in others)


