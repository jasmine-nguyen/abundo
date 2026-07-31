"""Adversarial QA for POST /milestones/review (WHIT-371) — the review_pacing client layer and the
non-ASCII scrub hole, mirroring test_milestone_suggest_adversarial.py.

review_pacing shares _call_anthropic with suggest_pacing, so the request/error plumbing is exercised
here directly (urllib.request.urlopen monkeypatched); _parse_review is the review-specific parser.
"""

import datetime
import io
import json
import urllib.error
import unicodedata
from decimal import Decimal

import pytest


# --- harness (mirrors test_milestone_review.py) ------------------------------

class FixedDate(datetime.date):
    @classmethod
    def today(cls):
        return datetime.date(2026, 1, 15)


FACTS = {"original": 550000, "homeValue": 800000, "lvr": 68, "ratePct": 5.74, "baseRepay": 3000, "extra": 0}
BALANCE = {"balance": Decimal("500000"), "as_at": "2026-01-10"}
STORED = [{"id": "m1", "label": "Quarter down", "targetBalance": 400000, "targetDate": "2030-01-01"}]


class FakeMilestoneRepo:
    def get_milestones(self, scope="SHARED"):
        return list(STORED)


class FakeLoanFactsRepo:
    def get_loanfacts(self):
        return dict(FACTS)


class FakeHomeLoanRepo:
    def get_balance(self, account_id):
        return dict(BALANCE)


def _event():
    return {"rawPath": "/milestones/review", "requestContext": {"http": {"method": "POST"}}, "body": ""}


# --- honesty scrub: non-ASCII numerals (endpoint level) ----------------------


def test_reason_with_non_ascii_numeral_is_scrubbed(handler, monkeypatch):
    # The scrub strips EVERY number, not just ASCII digits: "½ a year behind" must reach the client
    # with no numeric character. Same _is_figure_char guarantee suggest uses.
    monkeypatch.setattr(handler, "date", FixedDate)
    monkeypatch.setattr(handler, "review_pacing", lambda _mi: [{"index": 0, "reason": "½ a year behind"}])
    resp = handler.review_milestones(
        _event(), FakeMilestoneRepo(), FakeHomeLoanRepo(), FakeLoanFactsRepo())
    assert resp["statusCode"] == 200
    reason = json.loads(resp["body"])["adjustments"][0]["reason"]
    numeric = [ch for ch in reason if unicodedata.numeric(ch, None) is not None]
    assert not numeric, f"numeric char(s) {numeric!r} leaked: {reason!r}"
    assert "a year behind" in reason


# --- review_pacing client layer ----------------------------------------------


class _FakeResponse:
    def __init__(self, payload):
        self._body = json.dumps(payload).encode() if payload is not None else b""

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self._body


def _messages_payload(text):
    return {"content": [{"type": "text", "text": text}]}


def _stub_key(monkeypatch):
    import insights_ai
    insights_ai._api_key = None
    monkeypatch.setattr(insights_ai, "get_param", lambda path: "test-anthropic-key")


def test_review_pacing_builds_request_and_parses(handler, monkeypatch):
    import milestone_ai
    _stub_key(monkeypatch)
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        captured["headers"] = req.headers
        captured["body"] = json.loads(req.data.decode())
        return _FakeResponse(_messages_payload(
            '{"adjustments": [{"index": 0, "reason": "behind your plan"}, '
            '{"index": 3, "reason": "drifting later"}]}'))

    monkeypatch.setattr(milestone_ai.urllib.request, "urlopen", fake_urlopen)
    model_input = {"milestones": [{"index": 0, "targetBalance": 400000, "targetDate": "2030-01-01",
                                   "projectedDate": "2036-03-01", "varianceMonths": 74}]}
    result = milestone_ai.review_pacing(model_input)

    assert result == [{"index": 0, "reason": "behind your plan"}, {"index": 3, "reason": "drifting later"}]
    assert captured["url"].endswith("/v1/messages")
    assert captured["headers"]["X-api-key"] == "test-anthropic-key"
    assert captured["headers"]["User-agent"] == "abundo-app-api"
    assert "varianceMonths" in captured["body"]["messages"][0]["content"]
    assert "reason" in captured["body"]["system"].lower()
    assert captured["body"]["thinking"] == {"type": "disabled"}


def test_review_pacing_extracts_json_wrapped_in_prose(handler, monkeypatch):
    import milestone_ai
    _stub_key(monkeypatch)
    monkeypatch.setattr(
        milestone_ai.urllib.request, "urlopen",
        lambda req, timeout=None: _FakeResponse(_messages_payload(
            'Sure!\n{"adjustments": [{"index": 1, "reason": "slipping"}]}\nHope that helps.')))
    assert milestone_ai.review_pacing({}) == [{"index": 1, "reason": "slipping"}]


def test_review_pacing_non_json_reply_degrades_to_empty(handler, monkeypatch):
    import milestone_ai
    _stub_key(monkeypatch)
    monkeypatch.setattr(
        milestone_ai.urllib.request, "urlopen",
        lambda req, timeout=None: _FakeResponse(_messages_payload("I could not do that.")))
    assert milestone_ai.review_pacing({}) == []


def test_review_pacing_braces_with_bad_json_degrades_to_empty(handler, monkeypatch):
    # A {...} span that isn't valid JSON (json.loads raises) -> [], never a crash.
    import milestone_ai
    _stub_key(monkeypatch)
    monkeypatch.setattr(
        milestone_ai.urllib.request, "urlopen",
        lambda req, timeout=None: _FakeResponse(_messages_payload("{not: valid, json}")))
    assert milestone_ai.review_pacing({}) == []


def test_parse_review_adjustments_not_a_list_is_empty(handler, monkeypatch):
    import milestone_ai
    _stub_key(monkeypatch)
    monkeypatch.setattr(
        milestone_ai.urllib.request, "urlopen",
        lambda req, timeout=None: _FakeResponse(_messages_payload('{"adjustments": "nope"}')))
    assert milestone_ai.review_pacing({}) == []


def test_review_pacing_drops_malformed_entries(handler, monkeypatch):
    # Non-dict entries, a bool index (int subclass), a non-int index, and a non-string reason are
    # all dropped; only well-formed {int index, str reason} entries survive.
    import milestone_ai
    _stub_key(monkeypatch)
    monkeypatch.setattr(
        milestone_ai.urllib.request, "urlopen",
        lambda req, timeout=None: _FakeResponse(_messages_payload(json.dumps({"adjustments": [
            {"index": 0, "reason": "keep"},
            "not-a-dict",
            {"index": True, "reason": "bool index"},
            {"index": "2", "reason": "string index"},
            {"index": 3, "reason": 99},
            {"index": 4, "reason": "also"},
        ]}))))
    assert milestone_ai.review_pacing({}) == [
        {"index": 0, "reason": "keep"}, {"index": 4, "reason": "also"}]


def test_review_pacing_http_error_raises_with_status(handler, monkeypatch):
    import milestone_ai
    _stub_key(monkeypatch)

    def boom(req, timeout=None):
        raise urllib.error.HTTPError("u", 429, "rate", None, io.BytesIO(b""))

    monkeypatch.setattr(milestone_ai.urllib.request, "urlopen", boom)
    with pytest.raises(milestone_ai.AnthropicError) as ei:
        milestone_ai.review_pacing({})
    assert ei.value.upstream_status == 429


def test_review_pacing_url_error_is_none_status(handler, monkeypatch):
    import milestone_ai
    _stub_key(monkeypatch)

    def boom(req, timeout=None):
        raise urllib.error.URLError("down")

    monkeypatch.setattr(milestone_ai.urllib.request, "urlopen", boom)
    with pytest.raises(milestone_ai.AnthropicError) as ei:
        milestone_ai.review_pacing({})
    assert ei.value.upstream_status is None


def test_review_pacing_ssm_failure_degrades_to_anthropic_error(handler, monkeypatch):
    import insights_ai
    import milestone_ai
    insights_ai._api_key = None

    def unreachable(req, timeout=None):
        raise AssertionError("urlopen must not run when the key can't be read")

    monkeypatch.setattr(milestone_ai.urllib.request, "urlopen", unreachable)
    monkeypatch.setattr(insights_ai, "get_param",
                        lambda path: (_ for _ in ()).throw(ValueError("no such param")))
    with pytest.raises(milestone_ai.AnthropicError) as ei:
        milestone_ai.review_pacing({})
    assert ei.value.upstream_status is None
