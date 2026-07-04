"""Tests for AI spending insights (WHIT-104).

Two layers, both without network/AWS:
  - the Anthropic client (`insights_ai` fixture): request shape, JSON parsing +
    fallbacks, error taxonomy, key caching. urllib.request.urlopen is monkeypatched.
  - the handler endpoints (`handler` fixture): get_ai_insights (cache read),
    generate_ai_insights (cache hit/miss/stale/error), assemble_insight_input.
    The Anthropic call and the repos are faked.
"""

import hashlib
import io
import json
import urllib.error
from decimal import Decimal

import pytest


class _FakeResponse:
    """Stand-in for urlopen()'s return: a context manager whose .read() -> bytes."""

    def __init__(self, payload):
        self._body = json.dumps(payload).encode() if payload is not None else b""

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self._body


def _messages_payload(text):
    """A minimal Anthropic Messages API success envelope carrying `text`."""
    return {"content": [{"type": "text", "text": text}]}


# --- Anthropic client (insights_ai) -----------------------------------------


def test_generate_suggestions_builds_request_and_parses(insights_ai, monkeypatch):
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        captured["headers"] = req.headers
        captured["body"] = json.loads(req.data.decode())
        return _FakeResponse(_messages_payload(
            '{"summary": "Solid cycle.", "suggestions": ["Cut coffee $20", "Watch groceries"]}'))

    monkeypatch.setattr(insights_ai.urllib.request, "urlopen", fake_urlopen)

    model_input = {"cycle": {"length": 14}, "categories": [{"name": "Coffee", "posted": 52.0}]}
    result = insights_ai.generate_suggestions(model_input)

    assert result == {"summary": "Solid cycle.", "suggestions": ["Cut coffee $20", "Watch groceries"]}
    # Right endpoint + the load-bearing headers (Cloudflare UA, api key, version).
    assert captured["url"].endswith("/v1/messages")
    # urllib title-cases header keys.
    assert captured["headers"]["X-api-key"] == "test-anthropic-key"
    assert captured["headers"]["Anthropic-version"]
    assert captured["headers"]["User-agent"]
    # The real numbers AND the "don't invent" instruction reach the model.
    assert "52.0" in captured["body"]["messages"][0]["content"]
    assert "only" in captured["body"]["system"].lower()


def test_generate_suggestions_extracts_json_wrapped_in_prose(insights_ai, monkeypatch):
    # Despite the "strict JSON" instruction a model may add prose; we extract the {...}.
    monkeypatch.setattr(
        insights_ai.urllib.request, "urlopen",
        lambda req, timeout=None: _FakeResponse(_messages_payload(
            'Sure! Here you go:\n{"summary": "ok", "suggestions": ["a"]}\nHope that helps.')))

    result = insights_ai.generate_suggestions({})
    assert result == {"summary": "ok", "suggestions": ["a"]}


def test_generate_suggestions_non_json_reply_degrades_gracefully(insights_ai, monkeypatch):
    monkeypatch.setattr(
        insights_ai.urllib.request, "urlopen",
        lambda req, timeout=None: _FakeResponse(_messages_payload("I could not analyse that.")))

    result = insights_ai.generate_suggestions({})
    assert result == {"summary": None, "suggestions": []}


def test_generate_suggestions_drops_non_string_suggestions(insights_ai, monkeypatch):
    monkeypatch.setattr(
        insights_ai.urllib.request, "urlopen",
        lambda req, timeout=None: _FakeResponse(_messages_payload(
            '{"summary": 5, "suggestions": ["keep", 3, "", "  ", "also"]}')))

    result = insights_ai.generate_suggestions({})
    assert result == {"summary": None, "suggestions": ["keep", "also"]}


def test_generate_suggestions_http_error_raises_with_status(insights_ai, monkeypatch):
    def boom(req, timeout=None):
        raise urllib.error.HTTPError("u", 429, "rate", None, io.BytesIO(b""))

    monkeypatch.setattr(insights_ai.urllib.request, "urlopen", boom)

    with pytest.raises(insights_ai.AnthropicError) as ei:
        insights_ai.generate_suggestions({})
    assert ei.value.upstream_status == 429


def test_generate_suggestions_url_error_is_none_status(insights_ai, monkeypatch):
    def boom(req, timeout=None):
        raise urllib.error.URLError("down")

    monkeypatch.setattr(insights_ai.urllib.request, "urlopen", boom)

    with pytest.raises(insights_ai.AnthropicError) as ei:
        insights_ai.generate_suggestions({})
    assert ei.value.upstream_status is None


def test_get_api_key_is_cached(insights_ai, monkeypatch):
    calls = []
    monkeypatch.setattr(insights_ai, "get_param", lambda path: calls.append(path) or "k")
    insights_ai._api_key = None
    insights_ai.get_api_key()
    insights_ai.get_api_key()
    assert len(calls) == 1  # SSM read once, then served from the module cache


def test_generate_suggestions_ssm_failure_degrades_to_anthropic_error(insights_ai, monkeypatch):
    # A missing/denied SSM key raises ValueError inside get_api_key(). It must surface
    # as an AnthropicError (-> 502), NOT an uncaught 500. urlopen must never run.
    def unreachable(req, timeout=None):
        raise AssertionError("urlopen must not run when the key can't be read")

    monkeypatch.setattr(insights_ai.urllib.request, "urlopen", unreachable)
    monkeypatch.setattr(insights_ai, "get_param",
                        lambda path: (_ for _ in ()).throw(ValueError("no such param")))
    insights_ai._api_key = None

    with pytest.raises(insights_ai.AnthropicError) as ei:
        insights_ai.generate_suggestions({})
    assert ei.value.upstream_status is None


# --- handler endpoints -------------------------------------------------------


class _FakeInsightRepo:
    def __init__(self, existing=None):
        self._existing = existing
        self.put_calls = []

    def get_insight(self, cycle_start):
        return self._existing

    def put_insight(self, cycle_start, summary, suggestions, generated_at, input_hash):
        self.put_calls.append({
            "cycle_start": cycle_start, "summary": summary, "suggestions": suggestions,
            "generated_at": generated_at, "input_hash": input_hash,
        })


class _FakePayCycleRepo:
    def get_paycycle(self):
        # A far-past payday + fortnightly length -> current_cycle_window yields a
        # deterministic cycle_start on any run.
        return {"length": 14, "last_pay_date": "2024-01-03"}


def _hash(model_input):
    return hashlib.sha256(
        json.dumps(model_input, sort_keys=True, default=str).encode()).hexdigest()


def test_generate_cache_hit_skips_the_paid_call(handler, monkeypatch):
    model_input = {"cycle": {"start": "2026-06-25"}, "categories": []}
    monkeypatch.setattr(handler, "assemble_insight_input",
                        lambda *a: (model_input, "2026-06-25"))

    def must_not_call(_input):
        raise AssertionError("generate_suggestions must not run on a cache hit")

    monkeypatch.setattr(handler, "generate_suggestions", must_not_call)
    repo = _FakeInsightRepo(existing={
        "summary": "cached", "suggestions": ["x"], "generated_at": "t", "input_hash": _hash(model_input)})

    resp = handler.generate_ai_insights(None, None, None, None, repo)

    assert resp["statusCode"] == 200
    body = json.loads(resp["body"])
    assert body["cached"] is True and body["summary"] == "cached"
    assert repo.put_calls == []  # nothing re-stored


def test_generate_cache_miss_calls_and_stores(handler, monkeypatch):
    model_input = {"cycle": {"start": "2026-06-25"}, "categories": []}
    monkeypatch.setattr(handler, "assemble_insight_input",
                        lambda *a: (model_input, "2026-06-25"))
    monkeypatch.setattr(handler, "generate_suggestions",
                        lambda _input: {"summary": "fresh", "suggestions": ["cut coffee"]})
    repo = _FakeInsightRepo(existing=None)

    resp = handler.generate_ai_insights(None, None, None, None, repo)

    assert resp["statusCode"] == 200
    body = json.loads(resp["body"])
    assert body["cached"] is False and body["summary"] == "fresh"
    # Stored under the cycle key with the input hash so a later unchanged run is free.
    assert len(repo.put_calls) == 1
    assert repo.put_calls[0]["cycle_start"] == "2026-06-25"
    assert repo.put_calls[0]["input_hash"] == _hash(model_input)


def test_generate_stale_cache_regenerates(handler, monkeypatch):
    model_input = {"cycle": {"start": "2026-06-25"}, "categories": [{"name": "Coffee", "posted": 9.0}]}
    monkeypatch.setattr(handler, "assemble_insight_input",
                        lambda *a: (model_input, "2026-06-25"))
    monkeypatch.setattr(handler, "generate_suggestions",
                        lambda _input: {"summary": "new", "suggestions": []})
    # A cached row whose hash no longer matches the current input -> regenerate.
    repo = _FakeInsightRepo(existing={
        "summary": "old", "suggestions": [], "generated_at": "t", "input_hash": "STALE"})

    resp = handler.generate_ai_insights(None, None, None, None, repo)

    assert json.loads(resp["body"])["summary"] == "new"
    assert len(repo.put_calls) == 1


def test_generate_anthropic_error_returns_502(handler, monkeypatch):
    monkeypatch.setattr(handler, "assemble_insight_input", lambda *a: ({}, "2026-06-25"))

    def boom(_input):
        raise handler.AnthropicError(500, "upstream")

    monkeypatch.setattr(handler, "generate_suggestions", boom)
    repo = _FakeInsightRepo(existing=None)

    resp = handler.generate_ai_insights(None, None, None, None, repo)

    assert resp["statusCode"] == 502
    assert repo.put_calls == []  # nothing cached on failure


def test_get_ai_insights_returns_cached(handler):
    repo = _FakeInsightRepo(existing={
        "summary": "hi", "suggestions": ["a"], "generated_at": "t", "input_hash": "h"})
    out = handler.get_ai_insights(repo, _FakePayCycleRepo())
    assert out["cached"] is True and out["summary"] == "hi" and out["suggestions"] == ["a"]


def test_get_ai_insights_null_sentinel_when_absent(handler):
    out = handler.get_ai_insights(_FakeInsightRepo(existing=None), _FakePayCycleRepo())
    assert out["summary"] is None and out["suggestions"] == [] and out["cached"] is False
    assert out["cycle_start"]  # a real cycle key is still returned


# --- assemble_insight_input --------------------------------------------------


class _FakeCategoryRepo:
    def list_categories(self):
        return [
            {"id": "groceries", "name": "Groceries", "bucket": "Living"},
            {"id": "coffee", "name": "Coffee", "bucket": "Lifestyle"},
            {"id": "salary", "name": "Salary", "bucket": "Income"},
        ]


class _FakeBudgetRepo:
    def list_budgets(self):
        return {"groceries": {"target": Decimal("300")}}


class _FakeTxnRepo:
    """Serves a per-window transaction list, once for the FIRST account and empty
    for the rest (so _fetch_windowed_transactions' account loop doesn't triple it)."""

    def __init__(self, by_window):
        self._by_window = by_window
        self._first_account = None

    def get_transactions_by_date_range(self, account_id, start, end, limit=20, cursor=None):
        if self._first_account is None:
            self._first_account = account_id
        if account_id != self._first_account:
            return [], None
        return self._by_window.get((start, end), []), None


def _txn(category, amount, status="posted"):
    return {"category": category, "amount": Decimal(str(amount)), "status": status,
            "counts_to_budget": True}


def test_assemble_input_has_spend_budgets_prior_and_no_loan_data(handler):
    # Current window [2024-01-03, ...] per the far-past payday; prior window is the
    # 14 days before cycle_start. current_cycle_window gives cycle_start=today's
    # aligned payday; use the paycycle fake's fixed cycle. We compute the windows the
    # same way the code does by driving through the real current_cycle_window.
    cycle = _FakePayCycleRepo().get_paycycle()
    start, end = handler.current_cycle_window(cycle["last_pay_date"], cycle["length"])
    from datetime import date, timedelta
    prev_end = (date.fromisoformat(start) - timedelta(days=1)).isoformat()
    prev_start = (date.fromisoformat(start) - timedelta(days=cycle["length"])).isoformat()

    txn_repo = _FakeTxnRepo({
        (start, end): [_txn("groceries", -120.50), _txn("coffee", -18, "pending")],
        (prev_start, prev_end): [_txn("coffee", -40)],
    })

    model_input, cycle_start = handler.assemble_insight_input(
        _FakeCategoryRepo(), _FakeBudgetRepo(), txn_repo, _FakePayCycleRepo())

    assert cycle_start == start
    names = {row["name"]: row for row in model_input["categories"]}
    assert names["Groceries"]["posted"] == 120.5
    assert names["Groceries"]["budget"] == 300.0     # budget target joined by id
    assert names["Coffee"]["pending"] == 18.0
    # Prior cycle carried for trend.
    assert model_input["prior_cycles"][0]["categories"][0]["name"] == "Coffee"
    # SPEND-ONLY scope: no loan/goal fields anywhere in the payload.
    blob = json.dumps(model_input).lower()
    assert "loan" not in blob and "balance" not in blob and "mortgage" not in blob


class _DupNameCategoryRepo:
    """Two spend categories that SHARE a display name but differ by id + budget —
    the case a name-join would collapse."""

    def list_categories(self):
        return [
            {"id": "coffee_a", "name": "Coffee", "bucket": "Lifestyle"},
            {"id": "coffee_b", "name": "Coffee", "bucket": "Lifestyle"},
        ]


class _DupNameBudgetRepo:
    def list_budgets(self):
        return {"coffee_a": {"target": Decimal("100")}, "coffee_b": {"target": Decimal("200")}}


def test_window_category_spend_joins_budgets_by_id_not_name(handler):
    # Same display name, different ids/budgets -> each row keeps its OWN budget.
    cats = _DupNameCategoryRepo().list_categories()
    targets = _DupNameBudgetRepo().list_budgets()
    txns = [_txn("coffee_a", -10), _txn("coffee_b", -20)]
    rows = handler._window_category_spend(txns, cats, targets)
    budgets = sorted(r["budget"] for r in rows)
    assert budgets == [100.0, 200.0]  # not both 100 or both 200 (a name-join bug)


def test_window_category_spend_row_order_is_name_sorted_and_hash_stable(handler):
    # Row order must not depend on transaction arrival order, else the input_hash
    # flips and a truly-unchanged cycle pays for a needless regeneration.
    cats = [
        {"id": "z", "name": "Zebra", "bucket": "Lifestyle"},
        {"id": "a", "name": "Apple", "bucket": "Lifestyle"},
    ]
    rows_fwd = handler._window_category_spend([_txn("z", -5), _txn("a", -9)], cats)
    rows_rev = handler._window_category_spend([_txn("a", -9), _txn("z", -5)], cats)
    assert [r["name"] for r in rows_fwd] == ["Apple", "Zebra"]
    assert rows_fwd == rows_rev
    assert _hash(rows_fwd) == _hash(rows_rev)


def test_window_category_spend_ties_break_on_id_for_stable_hash(handler):
    # Two spend categories that SHARE a display name: a name-only sort leaves them in
    # transaction-arrival order (nondeterministic across DynamoDB pages) -> the hash
    # flips and an unchanged cycle pays for a needless regeneration. The id tiebreaker
    # must make both arrival orders produce the same rows + hash.
    cats = [
        {"id": "coffee_a", "name": "Coffee", "bucket": "Lifestyle"},
        {"id": "coffee_b", "name": "Coffee", "bucket": "Lifestyle"},
    ]
    targets = {"coffee_a": {"target": Decimal("100")}, "coffee_b": {"target": Decimal("200")}}
    rows_fwd = handler._window_category_spend([_txn("coffee_a", -10), _txn("coffee_b", -20)], cats, targets)
    rows_rev = handler._window_category_spend([_txn("coffee_b", -20), _txn("coffee_a", -10)], cats, targets)
    assert rows_fwd == rows_rev
    assert _hash(rows_fwd) == _hash(rows_rev)


def test_assemble_input_has_no_decimal_values(handler):
    # Everything handed to json.dumps for the model + the hash must be plain floats;
    # a leaked Decimal would blow up json.dumps (default=str only saves the hash path).
    cycle = _FakePayCycleRepo().get_paycycle()
    start, end = handler.current_cycle_window(cycle["last_pay_date"], cycle["length"])
    txn_repo = _FakeTxnRepo({(start, end): [_txn("groceries", -50)]})

    model_input, _ = handler.assemble_insight_input(
        _FakeCategoryRepo(), _FakeBudgetRepo(), txn_repo, _FakePayCycleRepo())

    def assert_no_decimal(node):
        assert not isinstance(node, Decimal)
        if isinstance(node, dict):
            for v in node.values():
                assert_no_decimal(v)
        elif isinstance(node, list):
            for v in node:
                assert_no_decimal(v)

    assert_no_decimal(model_input)
    json.dumps(model_input)  # would raise if a Decimal slipped through


def test_assemble_prior_window_is_the_cycle_before_start(handler):
    # The prior window must be [start-length, start-1] — contiguous, non-overlapping.
    cycle = _FakePayCycleRepo().get_paycycle()
    start, end = handler.current_cycle_window(cycle["last_pay_date"], cycle["length"])
    from datetime import date, timedelta
    prev_end = (date.fromisoformat(start) - timedelta(days=1)).isoformat()
    prev_start = (date.fromisoformat(start) - timedelta(days=cycle["length"])).isoformat()

    txn_repo = _FakeTxnRepo({
        (start, end): [_txn("coffee", -5)],
        (prev_start, prev_end): [_txn("coffee", -7)],
    })
    model_input, _ = handler.assemble_insight_input(
        _FakeCategoryRepo(), _FakeBudgetRepo(), txn_repo, _FakePayCycleRepo())

    prior = model_input["prior_cycles"][0]
    assert prior["start"] == prev_start and prior["end"] == prev_end
    assert date.fromisoformat(prior["end"]) < date.fromisoformat(start)
