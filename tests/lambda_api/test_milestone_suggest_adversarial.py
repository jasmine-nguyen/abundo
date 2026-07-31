"""Adversarial QA for POST /milestones/suggest (WHIT-370) — gaps the implementer's
test_milestone_suggest.py does not cover.

Same harness as the sibling suite: the `handler` fixture, a pinned FixedDate, and a stubbed
suggest_pacing so these are handler tests, not network tests. These originally included two
bug-EXPOSING tests (a false payoffDate past the 100-year cap, and a scrub hole for non-ASCII
numerals) that failed on the first cut of the endpoint; the fixes have landed, so both are now
paired with the prod change and assert the corrected contract. The rest are regression guards.
"""

import datetime
import json
import unicodedata

import pytest
from decimal import Decimal


# --- harness (mirrors test_milestone_suggest.py) -----------------------------

class FixedDate(datetime.date):
    @classmethod
    def today(cls):
        return datetime.date(2026, 1, 15)


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
    return {
        "rawPath": "/milestones/suggest",
        "requestContext": {"http": {"method": "POST"}},
        "body": json.dumps(body) if not isinstance(body, str) else body,
        "isBase64Encoded": False,
    }


def _stub_pacing(handler, monkeypatch, pacing, capture=None):
    def fake(model_input):
        if capture is not None:
            capture["model_input"] = model_input
        return pacing
    monkeypatch.setattr(handler, "suggest_pacing", fake)


def _suggest(handler, monkeypatch, body=None, pacing=None, capture=None,
             facts=FACTS, balance=BALANCE):
    if body is None:
        body = {"targetDate": "2035-06-01", "extraMonthly": 0}
    if pacing is None:
        pacing = [{"index": 0, "label": "ok"}]
    monkeypatch.setattr(handler, "date", FixedDate)
    _stub_pacing(handler, monkeypatch, pacing, capture)
    resp = handler.suggest_milestones(
        _event(body), FakeHomeLoanRepo(balance), FakeLoanFactsRepo(facts))
    return resp["statusCode"], json.loads(resp["body"])


def _no_ai(handler, monkeypatch):
    monkeypatch.setattr(handler, "date", FixedDate)
    monkeypatch.setattr(handler, "suggest_pacing",
                        lambda _mi: (_ for _ in ()).throw(AssertionError("no AI call")))


# =====================================================================================
# HONESTY CONTRACT (were bug-exposers; now paired with the landed fix)
# =====================================================================================

def test_payoff_beyond_1200_month_cap_is_honest_no_plan(handler, monkeypatch):
    # WHIT-370 — honesty of payoffDate.
    # baseRepay 2392 is a hair above the ~$2391.67/mo interest on $500k @5.74%, so the real payoff
    # is ~1860 months — past our 100-year (1200-month) horizon. We must NOT truncate the curve and
    # report the still-owing final month as a payoffDate. Contract: honest no-plan — empty
    # milestones, payoffDate None, and a shortfall telling them the extra/month needed — and NO AI
    # call (the paydown math already decided it doesn't clear). Fail-on-revert: the old code built
    # a truncated curve and called the AI, so the no-AI stub below would fire.
    def no_ai(_mi):
        raise AssertionError("no AI call when the loan doesn't pay off within the horizon")

    monkeypatch.setattr(handler, "date", FixedDate)
    monkeypatch.setattr(handler, "suggest_pacing", no_ai)
    resp = handler.suggest_milestones(
        _event({"targetDate": "2035-06-01", "extraMonthly": 0}),
        FakeHomeLoanRepo(BALANCE), FakeLoanFactsRepo({**FACTS, "baseRepay": 2392}))

    assert resp["statusCode"] == 200
    body = json.loads(resp["body"])
    assert body["milestones"] == []
    assert body["payoffDate"] is None                       # never a truncated, still-owing date
    assert body["shortfall"]["requiredExtraMonthly"] > 0
    assert body["shortfall"]["achievablePayoffDate"] is None


def test_label_with_non_ascii_numeral_is_scrubbed(handler, monkeypatch):
    # WHIT-370 — the honesty scrub must strip EVERY number, not just ASCII/decimal digits.
    # A model reply of "½ way there" must not reach the client with a numeral in it (the old
    # [\d$£€%] regex missed Unicode "No" numerals — vulgar fractions, superscripts, circled
    # digits). Contract: no character with a Unicode numeric value survives in a label.
    status, body = _suggest(
        handler, monkeypatch,
        pacing=[{"index": 2, "label": "½ way there"}])

    assert status == 200
    label = body["milestones"][0]["label"]
    numeric = [ch for ch in label if unicodedata.numeric(ch, None) is not None]
    assert not numeric, f"numeric character(s) {numeric!r} leaked through the scrub: {label!r}"
    assert "way there" in label  # the words survive


# =====================================================================================
# GREEN REGRESSION GUARDS (pass on current code)
# =====================================================================================

def test_missing_extra_monthly_is_400(handler, monkeypatch):
    # extraMonthly omitted entirely -> body.get returns None -> _finite_number(None) is False
    # -> 400, before any curve math or AI call. Locks the "field is required" contract (the
    # implementer's 400 sweep only covers PRESENT-but-bad values, never the missing key).
    _no_ai(handler, monkeypatch)
    resp = handler.suggest_milestones(
        _event({"targetDate": "2035-06-01"}),
        FakeHomeLoanRepo(BALANCE), FakeLoanFactsRepo(FACTS))
    assert resp["statusCode"] == 400


def test_null_extra_monthly_is_400(handler, monkeypatch):
    # extraMonthly explicitly JSON null -> None -> 400 (same as missing).
    _no_ai(handler, monkeypatch)
    resp = handler.suggest_milestones(
        _event({"targetDate": "2035-06-01", "extraMonthly": None}),
        FakeHomeLoanRepo(BALANCE), FakeLoanFactsRepo(FACTS))
    assert resp["statusCode"] == 400


@pytest.mark.parametrize("bal", [Decimal("0"), Decimal("-100")])
def test_already_cleared_balance_returns_honest_empty_200(handler, monkeypatch, bal):
    # A zero/negative stored balance is already mortgage-free: honest empty result (no plan, no
    # payoffDate to project, no shortfall), NOT the generic "try again" 502 and NOT a 409. No AI
    # call. Fail-on-revert: before the balance<=0 guard this fell through to an empty curve -> 502.
    _no_ai(handler, monkeypatch)
    resp = handler.suggest_milestones(
        _event({"targetDate": "2035-06-01", "extraMonthly": 0}),
        FakeHomeLoanRepo({"balance": bal}), FakeLoanFactsRepo(FACTS))
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"milestones": [], "payoffDate": None, "shortfall": None}


def test_all_indexes_out_of_range_soft_fails_502(handler, monkeypatch):
    # Distinct from empty pacing: the model DID choose, but every index is out of range, so
    # _clean_pacing_indices empties the list -> no milestones -> 502 (never an empty 200).
    status, body = _suggest(
        handler, monkeypatch,
        pacing=[{"index": 99999, "label": "after"}, {"index": -3, "label": "before"}])
    assert status == 502
    assert body["error"]


def test_dirty_first_label_poisons_its_index_even_with_a_clean_duplicate(handler, monkeypatch):
    # label_by_index keeps the FIRST label per index. If the model emits a digits-only label
    # for an index first and a clean one for the SAME index second, the clean one is discarded
    # and the point scrubs empty -> dropped. Here index 3 is the only choice -> whole plan 502.
    # Characterises a minor quality gap (a salvageable point is lost), not a crash.
    status, body = _suggest(
        handler, monkeypatch,
        pacing=[{"index": 3, "label": "2032"}, {"index": 3, "label": "Halfway"}])
    assert status == 502


def test_large_curve_downsampled_to_cap_keeps_the_real_payoff_last(handler, monkeypatch):
    # A long (base-payment) schedule has >36 months, so it's thinned to exactly the candidate
    # cap; the final candidate must stay the real payoff point (balance 0) and the set must
    # remain strictly paid-down. Guards the downsample against dropping/duplicating the payoff.
    cap = {}
    status, body = _suggest(
        handler, monkeypatch, capture=cap,
        body={"targetDate": "2060-01-01", "extraMonthly": 0},
        pacing=[{"index": 0, "label": "Start"}])
    assert status == 200
    cands = cap["model_input"]["candidates"]
    assert len(cands) == 36                         # capped
    assert cands[-1]["balance"] == 0                # real payoff preserved as the last point
    for prev, cur in zip(cands, cands[1:]):         # strictly paid-down, no dup from thinning
        assert cur["balance"] < prev["balance"]
        assert cur["date"] > prev["date"]


def test_base64_encoded_body_is_accepted(handler, monkeypatch):
    # The endpoint shares _parse_json_body, which handles base64 bodies (API Gateway can send
    # them). A valid base64 JSON body must drive a normal 200 — guards the decode path the
    # sibling suite always sends as plain text.
    import base64
    monkeypatch.setattr(handler, "date", FixedDate)
    _stub_pacing(handler, monkeypatch, [{"index": 0, "label": "Start"}])
    raw = json.dumps({"targetDate": "2035-06-01", "extraMonthly": 0}).encode()
    event = {
        "rawPath": "/milestones/suggest",
        "requestContext": {"http": {"method": "POST"}},
        "body": base64.b64encode(raw).decode(),
        "isBase64Encoded": True,
    }
    resp = handler.suggest_milestones(event, FakeHomeLoanRepo(BALANCE), FakeLoanFactsRepo(FACTS))
    assert resp["statusCode"] == 200


def test_response_shape_is_exactly_the_three_keys(handler, monkeypatch):
    # The client destructures {milestones, payoffDate, shortfall}. Lock the response contract so
    # a future refactor can't silently add/drop a top-level key.
    _, body = _suggest(handler, monkeypatch, pacing=[{"index": 1, "label": "On the way"}])
    assert set(body) == {"milestones", "payoffDate", "shortfall"}
    assert set(body["milestones"][0]) == {"label", "targetBalance", "targetDate"}
