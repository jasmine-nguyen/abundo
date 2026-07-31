"""Tests for POST /milestones/suggest — the AI-drafted starter milestone plan (WHIT-370).

The honesty contract is the point of this suite: OUR code computes every number from the
live balance + loan facts; Claude only chooses WHICH server-computed points to surface and
writes a word-only label. So the tests prove, over and over, that the numbers in the response
come from the server's own curve (never the model), and that any digit/currency a label smuggles
in is scrubbed server-side.

`handler.suggest_pacing` (the Anthropic call) is stubbed throughout — these are handler tests, not
network tests; the client itself is covered by the milestone_ai fixture below and test_paydown.py.
`handler.date` is pinned so the curve + payoff dates are deterministic.
"""

import datetime
import json
import urllib.error
from decimal import Decimal

import pytest

from _anthropic_fakes import FakeResponse, text_payload


# --- deterministic "today" ---------------------------------------------------
# The endpoint calls date.today() for the curve start; pin it so every candidate date
# (and the payoffDate) is reproducible. date.fromisoformat still works on the subclass.

class FixedDate(datetime.date):
    @classmethod
    def today(cls):
        return datetime.date(2026, 1, 15)


# Real, plausible loan facts + balance. The handler reads ONLY ratePct + baseRepay off facts
# and .balance off the stored row — extra keys mimic the real repo without being consulted.
FACTS = {"ratePct": 5.74, "baseRepay": 3000, "termYears": 30, "lender": "Up"}
BALANCE = {"balance": Decimal("500000"), "as_at": "2026-01-10"}


class FakeLoanFactsRepo:
    def __init__(self, facts=FACTS):
        self._facts = facts

    def get_loanfacts(self):
        return dict(self._facts) if self._facts is not None else None


class FakeHomeLoanRepo:
    def __init__(self, balance=BALANCE):
        self._balance = balance

    def get_balance(self, account_id):
        return dict(self._balance) if self._balance is not None else None


def _event(body):
    """A POST /milestones/suggest event carrying `body` (dict -> JSON, or a raw string)."""
    return {
        "rawPath": "/milestones/suggest",
        "requestContext": {"http": {"method": "POST"}},
        "body": json.dumps(body) if not isinstance(body, str) else body,
        "isBase64Encoded": False,
    }


def _stub_pacing(handler, monkeypatch, pacing, capture=None):
    """Replace the Anthropic call with a stub that (optionally) captures the model_input it was
    handed and returns `pacing` — a fixed [{index, label}] list. Returning caller-chosen indexes
    lets a test assert the response's numbers equal the CAPTURED candidates at those indexes,
    which is the proof the figures are server-derived, not model-invented."""
    def fake(model_input):
        if capture is not None:
            capture["model_input"] = model_input
        return pacing
    monkeypatch.setattr(handler, "suggest_pacing", fake)


def _suggest(handler, monkeypatch, body=None, pacing=None, capture=None,
             facts=FACTS, balance=BALANCE):
    """Drive suggest_milestones with sane defaults; return the parsed (status, body)."""
    if body is None:
        body = {"targetDate": "2035-06-01", "extraMonthly": 0}
    if pacing is None:
        pacing = [{"index": 0, "label": "ok"}]
    monkeypatch.setattr(handler, "date", FixedDate)
    _stub_pacing(handler, monkeypatch, pacing, capture)
    resp = handler.suggest_milestones(
        _event(body), FakeHomeLoanRepo(balance), FakeLoanFactsRepo(facts))
    return resp["statusCode"], json.loads(resp["body"])


# --- honesty: the numbers come from OUR curve, never the model ---------------


def test_response_numbers_are_the_servers_candidates_not_the_model(handler, monkeypatch):
    # The model chooses indexes 1, 3, 5; the response's targetBalance/targetDate at each of
    # those milestones must EQUAL the server-computed candidate the endpoint handed the model.
    # This is the core honesty guarantee: the figures are looked up from OUR curve by index.
    cap = {}
    pacing = [
        {"index": 1, "label": "Great start"},
        {"index": 3, "label": "Halfway there"},
        {"index": 5, "label": "Almost home"},
    ]
    status, body = _suggest(handler, monkeypatch, pacing=pacing, capture=cap)

    assert status == 200
    candidates = {c["index"]: c for c in cap["model_input"]["candidates"]}
    got = body["milestones"]
    assert [m["label"] for m in got] == ["Great start", "Halfway there", "Almost home"]
    for milestone, idx in zip(got, (1, 3, 5)):
        assert milestone["targetBalance"] == candidates[idx]["balance"]
        assert milestone["targetDate"] == candidates[idx]["date"]


def test_model_input_carries_numbers_only_no_pii(handler, monkeypatch):
    # Privacy discipline (matches insights_ai): the blob handed to the model has the target +
    # payoff dates and index/balance/date candidates — and NOTHING that identifies the user
    # (no account id, no transactions, no lender name).
    cap = {}
    _suggest(handler, monkeypatch, capture=cap)

    mi = cap["model_input"]
    assert set(mi) == {"targetDate", "payoffDate", "candidates"}
    assert mi["targetDate"] == "2035-06-01"
    assert all(set(c) == {"index", "balance", "date"} for c in mi["candidates"])
    blob = json.dumps(mi).lower()
    for leak in ("account", "up-homeloan", "transaction", "ratepct", "lender", "up"):
        assert leak not in blob


def test_candidate_indexes_are_contiguous_from_zero(handler, monkeypatch):
    # The model is told to choose from these indexes, so they must be a clean 0..N-1 range —
    # the exact keys _build_suggested_milestones will map back through.
    cap = {}
    _suggest(handler, monkeypatch, capture=cap)
    indexes = [c["index"] for c in cap["model_input"]["candidates"]]
    assert indexes == list(range(len(indexes)))


# --- label sanitisation: the honesty scrub (fail-on-revert) ------------------


def test_dirty_label_has_its_digits_and_currency_scrubbed(handler, monkeypatch):
    # A model that ignores the "words only" instruction and returns "$250,000 to go — 50%!"
    # must NOT reach the client with a number in it. The server strips every digit/currency/
    # percent glyph. Fail-on-revert: drop the scrub and this label keeps its "$250,000"/"50%".
    status, body = _suggest(
        handler, monkeypatch,
        pacing=[{"index": 2, "label": "$250,000 to go — 50%!"}])

    assert status == 200
    label = body["milestones"][0]["label"]
    assert not any(ch.isdigit() for ch in label)
    for glyph in ("$", "£", "€", "%"):
        assert glyph not in label
    assert "to go" in label  # the words survive; only the figures are stripped


def test_label_that_is_all_digits_drops_that_milestone(handler, monkeypatch):
    # A pure-number label ("2032") scrubs to empty -> that milestone is dropped. The other,
    # word-labelled milestone survives, so the plan still returns 200.
    status, body = _suggest(
        handler, monkeypatch,
        pacing=[{"index": 1, "label": "2032"}, {"index": 4, "label": "Almost there"}])

    assert status == 200
    labels = [m["label"] for m in body["milestones"]]
    assert labels == ["Almost there"]


def test_all_labels_scrub_empty_soft_fails_502(handler, monkeypatch):
    # If EVERY chosen label is digits-only, nothing survives the scrub -> no usable plan ->
    # the same soft-fail 502 as any AI failure (the client shows "try again"), never a 500.
    status, body = _suggest(
        handler, monkeypatch,
        pacing=[{"index": 1, "label": "2032"}, {"index": 4, "label": "$ 300 000 50%"}])

    assert status == 502
    assert body["error"]


def test_whitespace_only_label_is_dropped(handler, monkeypatch):
    # A label of only spaces is not a real label -> dropped like an empty one.
    status, body = _suggest(
        handler, monkeypatch,
        pacing=[{"index": 1, "label": "   "}, {"index": 4, "label": "Home stretch"}])
    assert status == 200
    assert [m["label"] for m in body["milestones"]] == ["Home stretch"]


def test_overlong_label_is_dropped(handler, monkeypatch):
    # A label longer than the milestone cap is dropped (belt-and-braces vs a runaway model).
    status, body = _suggest(
        handler, monkeypatch,
        pacing=[{"index": 1, "label": "x" * 200}, {"index": 4, "label": "Nearly done"}])
    assert status == 200
    assert [m["label"] for m in body["milestones"]] == ["Nearly done"]


# --- index hygiene: trust the SORT, never the model --------------------------


def test_out_of_range_indexes_are_ignored(handler, monkeypatch):
    # Indexes below 0 or >= candidate_count can't map to a real point -> dropped. Only the
    # in-range index survives.
    cap = {}
    status, body = _suggest(
        handler, monkeypatch, capture=cap,
        pacing=[{"index": -1, "label": "before"}, {"index": 3, "label": "real"},
                {"index": 99999, "label": "after"}])

    assert status == 200
    assert [m["label"] for m in body["milestones"]] == ["real"]
    candidates = {c["index"]: c for c in cap["model_input"]["candidates"]}
    assert body["milestones"][0]["targetBalance"] == candidates[3]["balance"]


def test_duplicate_indexes_collapse_to_one(handler, monkeypatch):
    # The model repeats index 2; it must appear ONCE. The first clean label per index wins
    # (WHIT-389); both are clean here, so the earlier one, "Milestone", is kept.
    status, body = _suggest(
        handler, monkeypatch,
        pacing=[{"index": 2, "label": "Milestone"}, {"index": 2, "label": "dup"}])

    assert status == 200
    assert [m["label"] for m in body["milestones"]] == ["Milestone"]


def test_reversed_indexes_are_sorted_ascending(handler, monkeypatch):
    # The model returns indexes out of order; the server SORTS them, so the plan is always
    # strictly paid-down (decreasing balance, increasing date) regardless of model order.
    status, body = _suggest(
        handler, monkeypatch,
        pacing=[{"index": 5, "label": "late"}, {"index": 1, "label": "early"},
                {"index": 3, "label": "mid"}])

    assert status == 200
    got = body["milestones"]
    assert [m["label"] for m in got] == ["early", "mid", "late"]
    for prev, cur in zip(got, got[1:]):
        assert cur["targetBalance"] < prev["targetBalance"]
        assert cur["targetDate"] > prev["targetDate"]


def test_index_zero_is_a_valid_choice(handler, monkeypatch):
    # 0 is in range [0, count) -> a legitimate (earliest) milestone, not treated as falsy.
    cap = {}
    status, body = _suggest(
        handler, monkeypatch, capture=cap,
        pacing=[{"index": 0, "label": "First step"}])

    assert status == 200
    candidates = {c["index"]: c for c in cap["model_input"]["candidates"]}
    assert body["milestones"][0]["targetBalance"] == candidates[0]["balance"]


def test_empty_pacing_soft_fails_502(handler, monkeypatch):
    # The model chose nothing -> no plan -> soft-fail 502, never a 500 or an empty 200.
    status, body = _suggest(handler, monkeypatch, pacing=[])
    assert status == 502
    assert body["error"]


def test_non_int_index_and_non_str_label_are_filtered(handler, monkeypatch):
    # Two more shapes the model could return past the client parse: a non-int (float) index is
    # dropped by _clean_pacing_indices; a non-string label is dropped by _clean_suggest_label.
    # Only the well-formed milestone survives.
    status, body = _suggest(handler, monkeypatch, pacing=[
        {"index": 2.5, "label": "floaty"},   # non-int index -> dropped
        {"index": 3, "label": 999},          # non-str label -> dropped
        {"index": 5, "label": "Real one"},
    ])
    assert status == 200
    assert [m["label"] for m in body["milestones"]] == ["Real one"]


def test_short_curve_is_not_downsampled(handler, monkeypatch):
    # A huge extra payment clears the loan in a handful of months -> the curve is shorter than
    # the candidate cap, so every month stays a candidate (the no-downsample branch).
    cap = {}
    status, body = _suggest(
        handler, monkeypatch, capture=cap,
        body={"targetDate": "2035-06-01", "extraMonthly": 100000},
        pacing=[{"index": 0, "label": "Nearly instant"}])
    assert status == 200
    assert 0 < len(cap["model_input"]["candidates"]) < 36


# --- the payoffDate + shortfall signals --------------------------------------


def test_payoff_date_is_the_final_candidate_date(handler, monkeypatch):
    cap = {}
    status, body = _suggest(handler, monkeypatch, capture=cap)
    assert status == 200
    assert body["payoffDate"] == cap["model_input"]["candidates"][-1]["date"]
    assert body["payoffDate"] == cap["model_input"]["payoffDate"]


def test_no_shortfall_when_the_plan_beats_the_target(handler, monkeypatch):
    # $3000/mo clears ~$500k in ~334 months (~2053). A target far past that (2060) -> the plan
    # reaches the target comfortably -> shortfall is null.
    status, body = _suggest(
        handler, monkeypatch, body={"targetDate": "2060-01-01", "extraMonthly": 0})
    assert status == 200
    assert body["shortfall"] is None


def test_shortfall_reports_extra_needed_when_target_is_too_soon(handler, monkeypatch):
    # An aggressive target (2030) the base payment can't hit -> the plan still returns (honest),
    # but with a shortfall: the extra $/month needed and the date the chosen payment DOES reach.
    status, body = _suggest(
        handler, monkeypatch, body={"targetDate": "2030-01-01", "extraMonthly": 0})
    assert status == 200
    sf = body["shortfall"]
    assert sf is not None
    assert isinstance(sf["requiredExtraMonthly"], int) and sf["requiredExtraMonthly"] > 0
    # The achievable payoff date the payment truly reaches equals the plan's payoffDate.
    assert sf["achievablePayoffDate"] == body["payoffDate"]


def test_shortfall_credits_the_extra_the_user_proposed(handler, monkeypatch):
    # The "extra needed" figure is measured from base + the extraMonthly the user JUST entered
    # (matching src/context.tsx and achievablePayoffDate), NOT from baseRepay alone. The required
    # payment to hit the target depends only on balance/rate/months (not the payment), so the two
    # shortfalls for the same too-soon target must differ by EXACTLY the $1000 extra proposed.
    # Fail-on-revert (measured from baseRepay): both would be identical -> difference 0.
    _, base = _suggest(handler, monkeypatch, body={"targetDate": "2030-01-01", "extraMonthly": 0})
    _, boosted = _suggest(handler, monkeypatch, body={"targetDate": "2030-01-01", "extraMonthly": 1000})
    assert base["shortfall"] is not None and boosted["shortfall"] is not None
    delta = base["shortfall"]["requiredExtraMonthly"] - boosted["shortfall"]["requiredExtraMonthly"]
    assert delta == 1000


def test_payment_that_never_clears_returns_honest_no_plan(handler, monkeypatch):
    # baseRepay 2000 < monthly interest (~$2392 on $500k @5.74%): the balance never falls.
    # Honest answer: no milestones, no payoffDate, just the extra/month needed. No AI call.
    def must_not_call(_mi):
        raise AssertionError("suggest_pacing must not run when the loan never pays off")

    monkeypatch.setattr(handler, "date", FixedDate)
    monkeypatch.setattr(handler, "suggest_pacing", must_not_call)
    resp = handler.suggest_milestones(
        _event({"targetDate": "2035-06-01", "extraMonthly": 0}),
        FakeHomeLoanRepo(BALANCE),
        FakeLoanFactsRepo({**FACTS, "baseRepay": 2000}))

    assert resp["statusCode"] == 200
    body = json.loads(resp["body"])
    assert body["milestones"] == [] and body["payoffDate"] is None
    assert body["shortfall"]["requiredExtraMonthly"] > 0


def test_extra_monthly_speeds_up_the_payoff(handler, monkeypatch):
    # extraMonthly is added to baseRepay: a bigger payment must reach a strictly EARLIER
    # payoff date than the base plan. Proves the field flows into the curve math.
    _, base = _suggest(handler, monkeypatch, body={"targetDate": "2060-01-01", "extraMonthly": 0})
    _, boosted = _suggest(
        handler, monkeypatch, body={"targetDate": "2060-01-01", "extraMonthly": 2000})
    assert boosted["payoffDate"] < base["payoffDate"]


# --- preconditions: loan must be set up --------------------------------------


def test_null_loanfacts_is_409(handler, monkeypatch):
    monkeypatch.setattr(handler, "date", FixedDate)
    monkeypatch.setattr(handler, "suggest_pacing",
                        lambda _mi: (_ for _ in ()).throw(AssertionError("no AI call")))
    resp = handler.suggest_milestones(
        _event({"targetDate": "2035-06-01", "extraMonthly": 0}),
        FakeHomeLoanRepo(BALANCE), FakeLoanFactsRepo(None))
    assert resp["statusCode"] == 409
    assert "loan" in json.loads(resp["body"])["error"].lower()


@pytest.mark.parametrize("stored", [None, {"balance": None}, {"as_at": "2026-01-10"}])
def test_missing_balance_is_409(handler, monkeypatch, stored):
    # No stored row, an explicit null balance, or a row with no balance key -> 409, before
    # any curve math or AI call.
    monkeypatch.setattr(handler, "date", FixedDate)
    monkeypatch.setattr(handler, "suggest_pacing",
                        lambda _mi: (_ for _ in ()).throw(AssertionError("no AI call")))
    resp = handler.suggest_milestones(
        _event({"targetDate": "2035-06-01", "extraMonthly": 0}),
        FakeHomeLoanRepo(stored), FakeLoanFactsRepo(FACTS))
    assert resp["statusCode"] == 409


# --- AI failure -> 502 -------------------------------------------------------


@pytest.mark.parametrize("upstream", [429, 500, None])
def test_anthropic_error_becomes_502(handler, monkeypatch, upstream):
    monkeypatch.setattr(handler, "date", FixedDate)

    def boom(_mi):
        raise handler.AnthropicError(upstream, "upstream")

    monkeypatch.setattr(handler, "suggest_pacing", boom)
    resp = handler.suggest_milestones(
        _event({"targetDate": "2035-06-01", "extraMonthly": 0}),
        FakeHomeLoanRepo(BALANCE), FakeLoanFactsRepo(FACTS))
    assert resp["statusCode"] == 502
    assert json.loads(resp["body"])["error"]


# --- current_scope resolution ------------------------------------------------


def test_current_scope_is_consulted(handler, monkeypatch):
    # The endpoint resolves the owner via the shared multi-tenant seam even though it never
    # writes (so a per-user read is a one-line change later). Prove the seam is on the path.
    calls = []
    monkeypatch.setattr(handler, "current_scope",
                        lambda event: calls.append(event) or "SHARED")
    _suggest(handler, monkeypatch)
    assert len(calls) == 1


# --- body validation: 400s ---------------------------------------------------


@pytest.mark.parametrize("body", [
    {"extraMonthly": 0},                                   # no targetDate
    {"targetDate": "not-a-date", "extraMonthly": 0},       # unparseable
    {"targetDate": "2035-13-01", "extraMonthly": 0},       # month 13
    {"targetDate": "2035-02-30", "extraMonthly": 0},       # calendar-invalid
    {"targetDate": 20350601, "extraMonthly": 0},           # not a string
])
def test_bad_target_date_is_400(handler, monkeypatch, body):
    monkeypatch.setattr(handler, "date", FixedDate)
    monkeypatch.setattr(handler, "suggest_pacing",
                        lambda _mi: (_ for _ in ()).throw(AssertionError("no AI call")))
    resp = handler.suggest_milestones(
        _event(body), FakeHomeLoanRepo(BALANCE), FakeLoanFactsRepo(FACTS))
    assert resp["statusCode"] == 400


@pytest.mark.parametrize("extra", [-1, float("inf"), float("nan"), True, "500", 2_000_000_000])
def test_bad_extra_monthly_is_400(handler, monkeypatch, extra):
    # Negative, non-finite, bool (int subclass), string, and over-the-cap all rejected.
    monkeypatch.setattr(handler, "date", FixedDate)
    monkeypatch.setattr(handler, "suggest_pacing",
                        lambda _mi: (_ for _ in ()).throw(AssertionError("no AI call")))
    resp = handler.suggest_milestones(
        _event({"targetDate": "2035-06-01", "extraMonthly": extra}),
        FakeHomeLoanRepo(BALANCE), FakeLoanFactsRepo(FACTS))
    assert resp["statusCode"] == 400


def test_target_date_in_the_past_is_400(handler, monkeypatch):
    # today() is pinned to 2026-01-15; a target in 2020 is <= 0 months out -> 400 (after the
    # loan/balance checks, so this is the future-date guard, not a precondition).
    monkeypatch.setattr(handler, "date", FixedDate)
    monkeypatch.setattr(handler, "suggest_pacing",
                        lambda _mi: (_ for _ in ()).throw(AssertionError("no AI call")))
    resp = handler.suggest_milestones(
        _event({"targetDate": "2020-01-01", "extraMonthly": 0}),
        FakeHomeLoanRepo(BALANCE), FakeLoanFactsRepo(FACTS))
    assert resp["statusCode"] == 400
    assert "future" in json.loads(resp["body"])["error"].lower()


def test_same_month_target_is_400(handler, monkeypatch):
    # A target in the SAME calendar month as today -> 0 months out -> 400 (the boundary of the
    # future check, which counts whole months).
    monkeypatch.setattr(handler, "date", FixedDate)
    monkeypatch.setattr(handler, "suggest_pacing",
                        lambda _mi: (_ for _ in ()).throw(AssertionError("no AI call")))
    resp = handler.suggest_milestones(
        _event({"targetDate": "2026-01-31", "extraMonthly": 0}),
        FakeHomeLoanRepo(BALANCE), FakeLoanFactsRepo(FACTS))
    assert resp["statusCode"] == 400


@pytest.mark.parametrize("raw", ["not json", "[1,2,3]", ""])
def test_malformed_body_is_400(handler, monkeypatch, raw):
    monkeypatch.setattr(handler, "date", FixedDate)
    monkeypatch.setattr(handler, "suggest_pacing",
                        lambda _mi: (_ for _ in ()).throw(AssertionError("no AI call")))
    resp = handler.suggest_milestones(
        _event(raw), FakeHomeLoanRepo(BALANCE), FakeLoanFactsRepo(FACTS))
    assert resp["statusCode"] == 400


# --- routing -----------------------------------------------------------------


def test_route_dispatches_post_suggest(handler, monkeypatch):
    # The lambda_handler routes POST /milestones/suggest to suggest_milestones with the two
    # repos it needs. Stub the endpoint to a sentinel and prove the dispatch reaches it.
    monkeypatch.setattr(handler, "HomeLoanBalanceRepository", lambda: FakeHomeLoanRepo(BALANCE))
    monkeypatch.setattr(handler, "LoanFactsRepository", lambda: FakeLoanFactsRepo(FACTS))
    seen = {}

    def fake_suggest(event, homeloan_repo, loanfacts_repo):
        seen["hit"] = True
        return handler._json_response(200, {"ok": True})

    monkeypatch.setattr(handler, "suggest_milestones", fake_suggest)
    event = {
        "rawPath": "/milestones/suggest",
        "requestContext": {"http": {"method": "POST"}},
        "body": json.dumps({"targetDate": "2035-06-01", "extraMonthly": 0}),
    }
    resp = handler.lambda_handler(event, None)
    assert resp["statusCode"] == 200 and seen.get("hit")


# --- _build_suggested_milestones guards (direct) -----------------------------


def test_build_rejects_non_monotonic_candidates(handler):
    # Belt-and-braces honesty guard: even if the chosen indexes mapped to a NON-paid-down
    # sequence (balance rising), the builder returns None (soft fail) rather than emit an
    # out-of-order plan -- a second line of defence behind set_milestones' own ordering check.
    candidates = [
        {"balance": 100, "date": datetime.date(2026, 2, 1)},
        {"balance": 200, "date": datetime.date(2026, 3, 1)},   # balance goes UP -> invalid
    ]
    assert handler._build_suggested_milestones([0, 1], candidates, {0: "a", 1: "b"}) is None


def test_build_returns_none_when_every_label_scrubs_empty(handler):
    # All chosen labels scrub to nothing -> no milestones survive -> None (the caller 502s).
    candidates = [{"balance": 100, "date": datetime.date(2026, 2, 1)}]
    assert handler._build_suggested_milestones([0], candidates, {0: "2032"}) is None


# --- milestone_ai client (direct) --------------------------------------------
# The Anthropic client is stubbed in the handler tests above; here we test it directly,
# mirroring test_insights_ai's client layer. urllib.request.urlopen is monkeypatched.


def _stub_key(monkeypatch):
    """The key/HTTP plumbing lives in the shared anthropic_client (WHIT-388) that milestone_ai
    delegates to, so get_api_key resolves _api_key / get_param out of anthropic_client's module
    globals — patch THERE. The handler fixture already imported this package's copy."""
    import anthropic_client
    anthropic_client._api_key = None
    monkeypatch.setattr(anthropic_client, "get_param", lambda path: "test-anthropic-key")


def test_suggest_pacing_builds_request_and_parses(handler, monkeypatch):
    # Reuse the handler fixture's isolated import machinery: milestone_ai and anthropic_client
    # are registered in _COLLIDING, so importing them here resolves this package's copies.
    import anthropic_client as ac
    import milestone_ai
    _stub_key(monkeypatch)

    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        captured["headers"] = req.headers
        captured["body"] = json.loads(req.data.decode())
        return FakeResponse(text_payload(
            '{"milestones": [{"index": 0, "label": "Great start"}, '
            '{"index": 4, "label": "Almost home"}]}'))

    monkeypatch.setattr(ac.urllib.request, "urlopen", fake_urlopen)

    model_input = {"targetDate": "2035-06-01", "payoffDate": "2053-01-01",
                   "candidates": [{"index": 0, "balance": 500000, "date": "2026-02-01"}]}
    result = milestone_ai.suggest_pacing(model_input)

    assert result == [{"index": 0, "label": "Great start"}, {"index": 4, "label": "Almost home"}]
    assert captured["url"].endswith("/v1/messages")
    assert captured["headers"]["X-api-key"] == "test-anthropic-key"
    assert captured["headers"]["User-agent"] == "abundo-app-api"
    # The real numbers reach the model, and the "words only / choose provided indexes" rule.
    assert "500000" in captured["body"]["messages"][0]["content"]
    assert "index" in captured["body"]["system"].lower()
    # Thinking disabled so the JSON reply can't be truncated by internal reasoning.
    assert captured["body"]["thinking"] == {"type": "disabled"}


def test_suggest_pacing_extracts_json_wrapped_in_prose(handler, monkeypatch):
    import anthropic_client as ac
    import milestone_ai
    _stub_key(monkeypatch)
    monkeypatch.setattr(
        ac.urllib.request, "urlopen",
        lambda req, timeout=None: FakeResponse(text_payload(
            'Sure!\n{"milestones": [{"index": 1, "label": "Halfway"}]}\nHope that helps.')))
    assert milestone_ai.suggest_pacing({}) == [{"index": 1, "label": "Halfway"}]


def test_suggest_pacing_non_json_reply_degrades_to_empty(handler, monkeypatch):
    import anthropic_client as ac
    import milestone_ai
    _stub_key(monkeypatch)
    monkeypatch.setattr(
        ac.urllib.request, "urlopen",
        lambda req, timeout=None: FakeResponse(text_payload("I could not do that.")))
    assert milestone_ai.suggest_pacing({}) == []


def test_suggest_pacing_braces_with_bad_json_degrades_to_empty(handler, monkeypatch):
    # A {...} span that isn't valid JSON (json.loads raises) -> [] , never a crash.
    import anthropic_client as ac
    import milestone_ai
    _stub_key(monkeypatch)
    monkeypatch.setattr(
        ac.urllib.request, "urlopen",
        lambda req, timeout=None: FakeResponse(text_payload("{not: valid, json}")))
    assert milestone_ai.suggest_pacing({}) == []


def test_suggest_pacing_milestones_not_a_list_is_empty(handler, monkeypatch):
    # Valid JSON but "milestones" isn't a list -> [] (nothing to pace).
    import anthropic_client as ac
    import milestone_ai
    _stub_key(monkeypatch)
    monkeypatch.setattr(
        ac.urllib.request, "urlopen",
        lambda req, timeout=None: FakeResponse(text_payload('{"milestones": "nope"}')))
    assert milestone_ai.suggest_pacing({}) == []


def test_suggest_pacing_drops_malformed_entries(handler, monkeypatch):
    # Non-dict entries, a bool index (int subclass), a non-int index, and a non-string label
    # are all dropped; only the well-formed {int index, str label} entries survive.
    import anthropic_client as ac
    import milestone_ai
    _stub_key(monkeypatch)
    monkeypatch.setattr(
        ac.urllib.request, "urlopen",
        lambda req, timeout=None: FakeResponse(text_payload(json.dumps({"milestones": [
            {"index": 0, "label": "keep"},
            "not-a-dict",
            {"index": True, "label": "bool index"},
            {"index": "2", "label": "string index"},
            {"index": 3, "label": 99},
            {"index": 4, "label": "also"},
        ]}))))
    assert milestone_ai.suggest_pacing({}) == [
        {"index": 0, "label": "keep"}, {"index": 4, "label": "also"}]


def test_suggest_pacing_http_error_raises_with_status(handler, monkeypatch):
    import io
    import anthropic_client as ac
    import milestone_ai
    _stub_key(monkeypatch)

    def boom(req, timeout=None):
        raise urllib.error.HTTPError("u", 429, "rate", None, io.BytesIO(b""))

    monkeypatch.setattr(ac.urllib.request, "urlopen", boom)
    with pytest.raises(ac.AnthropicError) as ei:
        milestone_ai.suggest_pacing({})
    assert ei.value.upstream_status == 429


def test_suggest_pacing_url_error_is_none_status(handler, monkeypatch):
    import anthropic_client as ac
    import milestone_ai
    _stub_key(monkeypatch)

    def boom(req, timeout=None):
        raise urllib.error.URLError("down")

    monkeypatch.setattr(ac.urllib.request, "urlopen", boom)
    with pytest.raises(ac.AnthropicError) as ei:
        milestone_ai.suggest_pacing({})
    assert ei.value.upstream_status is None


def test_suggest_pacing_ssm_failure_degrades_to_anthropic_error(handler, monkeypatch):
    # A missing/denied SSM key raises ValueError inside get_api_key(); it must surface as an
    # AnthropicError (-> 502), never an uncaught 500, and urlopen must never run.
    import anthropic_client as ac
    import milestone_ai
    ac._api_key = None

    def unreachable(req, timeout=None):
        raise AssertionError("urlopen must not run when the key can't be read")

    monkeypatch.setattr(ac.urllib.request, "urlopen", unreachable)
    monkeypatch.setattr(ac, "get_param",
                        lambda path: (_ for _ in ()).throw(ValueError("no such param")))
    with pytest.raises(ac.AnthropicError) as ei:
        milestone_ai.suggest_pacing({})
    assert ei.value.upstream_status is None
