"""Tests for POST /milestones/review — the AI plan review (WHIT-371).

Sibling of the suggest suite. The honesty contract is the point: OUR code computes each saved
milestone's real projected date at the user's saved pace (baseRepay + extra); Claude only chooses
which behind-schedule ones to flag and writes a word-only reason. So the tests prove the dates in
the response come from the server's own paydown math (never the model), and that any digit/currency
a reason smuggles in is scrubbed server-side.

`handler.review_pacing` (the Anthropic call) is stubbed throughout; `handler.date` is pinned so the
projected dates are deterministic. today() = 2026-01-15.
"""

import datetime
import json
from decimal import Decimal

import pytest


class FixedDate(datetime.date):
    @classmethod
    def today(cls):
        return datetime.date(2026, 1, 15)


# ratePct 5.74, baseRepay 3000, extra 0 → pace 3000/mo on $500k clears in ~334.4 months (~2053).
FACTS = {"original": 550000, "homeValue": 800000, "lvr": 68, "ratePct": 5.74, "baseRepay": 3000, "extra": 0}
BALANCE = {"balance": Decimal("500000"), "as_at": "2026-01-10"}

# A saved plan whose targets are all reached far LATER than their planned dates → all behind.
# Projected dates at the pace above: 400k → 2036-03-01, 250k → 2045-01-01, 0 → 2053-12-01.
STORED = [
    {"id": "m1", "label": "Quarter down", "targetBalance": 400000, "targetDate": "2030-01-01"},
    {"id": "m2", "label": "Halfway", "targetBalance": 250000, "targetDate": "2040-01-01"},
    {"id": "m3", "label": "Mortgage-free", "targetBalance": 0, "targetDate": "2050-01-01"},
]


class FakeMilestoneRepo:
    def __init__(self, milestones=STORED):
        self._milestones = milestones

    def get_milestones(self, scope="SHARED"):
        return list(self._milestones) if self._milestones is not None else None


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


def _event():
    return {"rawPath": "/milestones/review", "requestContext": {"http": {"method": "POST"}}, "body": ""}


def _stub_pacing(handler, monkeypatch, pacing, capture=None):
    def fake(model_input):
        if capture is not None:
            capture["model_input"] = model_input
        return pacing
    monkeypatch.setattr(handler, "review_pacing", fake)


def _review(handler, monkeypatch, pacing=None, capture=None,
            stored=STORED, facts=FACTS, balance=BALANCE):
    if pacing is None:
        pacing = [{"index": 0, "reason": "running a little behind"}]
    monkeypatch.setattr(handler, "date", FixedDate)
    _stub_pacing(handler, monkeypatch, pacing, capture)
    resp = handler.review_milestones(
        _event(), FakeMilestoneRepo(stored), FakeHomeLoanRepo(balance), FakeLoanFactsRepo(facts))
    return resp["statusCode"], json.loads(resp["body"])


def _no_ai(handler, monkeypatch):
    monkeypatch.setattr(handler, "date", FixedDate)
    monkeypatch.setattr(handler, "review_pacing",
                        lambda _mi: (_ for _ in ()).throw(AssertionError("no AI call")))


# --- honesty: the dates come from OUR projection, never the model ------------


def test_response_dates_are_the_servers_projection_not_the_model(handler, monkeypatch):
    # The model flags indexes 0 and 2; each adjustment's suggestedTargetDate must EQUAL the server's
    # projectedDate for that candidate, the balance must be the STORED target (date-only), and the
    # milestoneId must be the stored id. This is the core honesty guarantee.
    cap = {}
    pacing = [{"index": 0, "reason": "behind your plan"}, {"index": 2, "reason": "drifting later"}]
    status, body = _review(handler, monkeypatch, pacing=pacing, capture=cap)

    assert status == 200
    candidates = {c["index"]: c for c in cap["model_input"]["milestones"]}
    got = body["adjustments"]
    assert [a["milestoneId"] for a in got] == ["m1", "m3"]
    for adjustment, idx in zip(got, (0, 2)):
        assert adjustment["suggestedTargetDate"] == candidates[idx]["projectedDate"]
        assert adjustment["suggestedTargetBalance"] == candidates[idx]["targetBalance"]   # unchanged
        assert adjustment["currentTargetBalance"] == candidates[idx]["targetBalance"]
        assert adjustment["varianceMonths"] == candidates[idx]["varianceMonths"]


def test_model_input_is_numbers_only_no_pii(handler, monkeypatch):
    # The blob handed to the model carries only index + the figures — NO milestone id, NO label,
    # no account/transaction data (matches insights_ai discipline).
    cap = {}
    _review(handler, monkeypatch, capture=cap)
    entries = cap["model_input"]["milestones"]
    assert all(set(e) == {"index", "targetBalance", "targetDate", "projectedDate", "varianceMonths"}
               for e in entries)
    blob = json.dumps(cap["model_input"]).lower()
    for leak in ("m1", "m2", "m3", "quarter down", "halfway", "mortgage-free", "account", "up-homeloan"):
        assert leak not in blob


def test_projected_payoff_date_uses_ceil_matches_suggest(handler, monkeypatch):
    # Fail-on-revert for ceil (not round): the "Mortgage-free" (target 0) milestone is reached at
    # ceil(334.38)=335 months → 2053-12-01. round() would give 334 → 2053-11-01, a month EARLY and
    # disagreeing with suggest's payoffDate (which pins the first whole month the balance clears).
    cap = {}
    _review(handler, monkeypatch, pacing=[{"index": 2, "reason": "the finish line moved"}], capture=cap)
    payoff_candidate = next(c for c in cap["model_input"]["milestones"] if c["targetBalance"] == 0)
    assert payoff_candidate["projectedDate"] == "2053-12-01"


def test_variance_is_months_behind_the_planned_date(handler, monkeypatch):
    # 400k is planned for 2030-01 but reached 2036-03 → 74 months behind (positive = behind).
    cap = {}
    _review(handler, monkeypatch, capture=cap)
    m1 = next(c for c in cap["model_input"]["milestones"] if c["targetBalance"] == 400000)
    assert m1["projectedDate"] == "2036-03-01"
    assert m1["varianceMonths"] == 74


# --- reason scrub (the honesty guarantee) ------------------------------------


def test_dirty_reason_is_scrubbed(handler, monkeypatch):
    # A reason that smuggles figures ("3 months behind — $20k short, 50%!") must reach the client
    # with no digit/currency/percent; the words survive. Fail-on-revert: drop the scrub and the
    # numbers stay.
    status, body = _review(
        handler, monkeypatch,
        pacing=[{"index": 0, "reason": "3 months behind — $20k short, 50%!"}])
    assert status == 200
    reason = body["adjustments"][0]["reason"]
    assert not any(ch.isdigit() for ch in reason)
    for glyph in ("$", "£", "€", "%"):
        assert glyph not in reason
    assert "months behind" in reason


def test_all_reasons_scrub_empty_soft_fails_502(handler, monkeypatch):
    # Real slippage exists (behind candidates) but every reason scrubs to nothing → no usable
    # adjustments → 502 "try again", NOT a false "on track" 200.
    status, body = _review(
        handler, monkeypatch,
        pacing=[{"index": 0, "reason": "2032"}, {"index": 1, "reason": "$ 20 000 50%"}])
    assert status == 502
    assert body["error"]


def test_reason_over_the_cap_is_dropped(handler, monkeypatch):
    # A reason longer than the reason cap (200) is dropped; a normal one survives.
    status, body = _review(
        handler, monkeypatch,
        pacing=[{"index": 0, "reason": "x" * 250}, {"index": 1, "reason": "slipping behind"}])
    assert status == 200
    assert [a["milestoneId"] for a in body["adjustments"]] == ["m2"]


# --- index hygiene -----------------------------------------------------------


def test_out_of_range_and_duplicate_indexes_are_handled(handler, monkeypatch):
    # Out-of-range indexes are dropped (no IndexError/500); a duplicate collapses to one (first
    # reason wins).
    status, body = _review(
        handler, monkeypatch,
        pacing=[{"index": -1, "reason": "before"}, {"index": 99, "reason": "after"},
                {"index": 1, "reason": "real"}, {"index": 1, "reason": "dup"}])
    assert status == 200
    assert [a["milestoneId"] for a in body["adjustments"]] == ["m2"]
    assert body["adjustments"][0]["reason"] == "real"


def test_empty_pacing_on_a_behind_plan_soft_fails_502(handler, monkeypatch):
    # The model chose nothing even though milestones are behind → a whiff → 502, never a false 200.
    status, body = _review(handler, monkeypatch, pacing=[])
    assert status == 502
    assert body["error"]


# --- gates: nothing to review ------------------------------------------------


def test_no_saved_plan_is_409(handler, monkeypatch):
    _no_ai(handler, monkeypatch)
    for empty in (None, []):
        resp = handler.review_milestones(
            _event(), FakeMilestoneRepo(empty), FakeHomeLoanRepo(BALANCE), FakeLoanFactsRepo(FACTS))
        assert resp["statusCode"] == 409
        assert "plan" in json.loads(resp["body"])["error"].lower()


def test_no_loanfacts_is_409(handler, monkeypatch):
    _no_ai(handler, monkeypatch)
    resp = handler.review_milestones(
        _event(), FakeMilestoneRepo(STORED), FakeHomeLoanRepo(BALANCE), FakeLoanFactsRepo(None))
    assert resp["statusCode"] == 409


@pytest.mark.parametrize("stored_balance", [None, {"balance": None}, {"as_at": "x"}])
def test_missing_balance_is_409(handler, monkeypatch, stored_balance):
    _no_ai(handler, monkeypatch)
    resp = handler.review_milestones(
        _event(), FakeMilestoneRepo(STORED), FakeHomeLoanRepo(stored_balance), FakeLoanFactsRepo(FACTS))
    assert resp["statusCode"] == 409


# --- honest empty results (200, no AI call) ----------------------------------


def test_already_paid_off_is_empty_feasible_200(handler, monkeypatch):
    _no_ai(handler, monkeypatch)
    resp = handler.review_milestones(
        _event(), FakeMilestoneRepo(STORED), FakeHomeLoanRepo({"balance": Decimal("0")}),
        FakeLoanFactsRepo(FACTS))
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"adjustments": [], "payoffFeasible": True}


def test_pace_never_pays_off_is_empty_infeasible_200(handler, monkeypatch):
    # baseRepay 2000 + extra 0 < monthly interest (~$2392) → no honest projected dates. No AI call.
    _no_ai(handler, monkeypatch)
    resp = handler.review_milestones(
        _event(), FakeMilestoneRepo(STORED), FakeHomeLoanRepo(BALANCE),
        FakeLoanFactsRepo({**FACTS, "baseRepay": 2000}))
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"adjustments": [], "payoffFeasible": False}


def test_pace_past_the_horizon_is_empty_infeasible_no_crash(handler, monkeypatch):
    # A valid but ultra-slow pace (payment a hair above interest) clears the loan tens of thousands
    # of months out — past the 100-year horizon. Without the cap, add_months would build a year
    # > 9999 and 500. Instead: honest {payoffFeasible: false}, no AI call, no crash. Fail-on-revert:
    # drop the _REVIEW_CURVE_MAX_MONTHS cap and the $0 milestone's projected date overflows.
    # ratePct 0.1 → ~$41.67/mo interest on $500k; baseRepay 41.68 is a hair above it → ~100k months
    # to clear → the $0 milestone's projected date lands past year 9999. Revert the cap and this
    # raises an uncaught ValueError (HTTP 500); with the cap it's an honest no-plan.
    _no_ai(handler, monkeypatch)
    resp = handler.review_milestones(
        _event(), FakeMilestoneRepo(STORED), FakeHomeLoanRepo(BALANCE),
        FakeLoanFactsRepo({**FACTS, "ratePct": 0.1, "baseRepay": 41.68}))
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"adjustments": [], "payoffFeasible": False}


def test_nothing_behind_is_empty_feasible_200_no_ai(handler, monkeypatch):
    # A plan whose targets are all planned LATER than they're really reached → nothing behind →
    # honest "on track" empty 200, and NO AI call (candidates empty before the model).
    _no_ai(handler, monkeypatch)
    on_track = [
        {"id": "a", "label": "Quarter down", "targetBalance": 400000, "targetDate": "2040-01-01"},
        {"id": "b", "label": "Halfway", "targetBalance": 250000, "targetDate": "2050-01-01"},
    ]
    resp = handler.review_milestones(
        _event(), FakeMilestoneRepo(on_track), FakeHomeLoanRepo(BALANCE), FakeLoanFactsRepo(FACTS))
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"adjustments": [], "payoffFeasible": True}


def test_milestone_at_or_above_current_balance_is_skipped(handler, monkeypatch):
    # A target >= the current balance is already reached-region — excluded from the candidates the
    # model sees (only the two below-balance behind targets remain).
    cap = {}
    stored = [
        {"id": "big", "label": "Above", "targetBalance": 600000, "targetDate": "2030-01-01"},
        {"id": "m1", "label": "Quarter down", "targetBalance": 400000, "targetDate": "2030-01-01"},
        {"id": "m2", "label": "Halfway", "targetBalance": 250000, "targetDate": "2040-01-01"},
    ]
    _review(handler, monkeypatch, stored=stored,
            pacing=[{"index": 0, "reason": "behind"}], capture=cap)
    targets = {c["targetBalance"] for c in cap["model_input"]["milestones"]}
    assert targets == {400000, 250000}   # 600000 (>= balance) skipped


# --- AI failure --------------------------------------------------------------


@pytest.mark.parametrize("upstream", [429, 500, None])
def test_anthropic_error_becomes_502(handler, monkeypatch, upstream):
    monkeypatch.setattr(handler, "date", FixedDate)

    def boom(_mi):
        raise handler.AnthropicError(upstream, "upstream")

    monkeypatch.setattr(handler, "review_pacing", boom)
    resp = handler.review_milestones(
        _event(), FakeMilestoneRepo(STORED), FakeHomeLoanRepo(BALANCE), FakeLoanFactsRepo(FACTS))
    assert resp["statusCode"] == 502
    assert json.loads(resp["body"])["error"]


# --- scope + routing ---------------------------------------------------------


def test_current_scope_is_consulted(handler, monkeypatch):
    calls = []
    monkeypatch.setattr(handler, "current_scope", lambda event: calls.append(event) or "SHARED")
    _review(handler, monkeypatch)
    assert len(calls) == 1


def test_route_dispatches_post_review(handler, monkeypatch):
    monkeypatch.setattr(handler, "MilestoneRepository", lambda: FakeMilestoneRepo(STORED))
    monkeypatch.setattr(handler, "HomeLoanBalanceRepository", lambda: FakeHomeLoanRepo(BALANCE))
    monkeypatch.setattr(handler, "LoanFactsRepository", lambda: FakeLoanFactsRepo(FACTS))
    seen = {}

    def fake_review(event, milestone_repo, homeloan_repo, loanfacts_repo):
        seen["hit"] = True
        return handler._json_response(200, {"ok": True})

    monkeypatch.setattr(handler, "review_milestones", fake_review)
    event = {"rawPath": "/milestones/review", "requestContext": {"http": {"method": "POST"}}, "body": ""}
    resp = handler.lambda_handler(event, None)
    assert resp["statusCode"] == 200 and seen.get("hit")
