"""Adversarial gap coverage for POST /milestones/review (WHIT-371) — QA pass.

The implementer's test_milestone_review.py locks the happy path, the honesty guarantee, the
taxonomy and index hygiene. These add the BOUNDARIES + adversarial mixes it leaves open, each proven
by fail-on-revert:

  [G1] target EXACTLY == current balance is skipped   (locks `>= balance`, not `> balance`)
  [G2] variance EXACTLY == 1 month is flagged          (locks the `< 1` threshold, kept side)
  [G3] variance EXACTLY == 0 (on-track) is skipped, no AI (locks the `< 1` threshold, dropped side)
  [G4] an overdue (past) targetDate → flagged, large positive variance, no crash
  [G5] a mixed plan (cleared + on-track + behind) → only the behind-below-balance one reaches the model
  [G6] per-index scrub isolation — one dirty reason is dropped, its clean sibling survives (no 502)
  [G7] duplicate index, first (dirty) reason but a clean twin later → the clean twin is kept (WHIT-389:
       prefer the first value that survives the scrub over the first merely seen)

Harness mirrors test_milestone_review.py: `handler` fixture, FixedDate (today = 2026-01-15),
stubbed handler.review_pacing. Pace: $500k @ 5.74% paying $3000/mo → 400k reached 2036-03-01,
250k reached 2045-01-01, payoff (0) 2053-12-01 (ceil of 334.38 = 335 months).
"""

import datetime
import json
from decimal import Decimal

import pytest


class FixedDate(datetime.date):
    @classmethod
    def today(cls):
        return datetime.date(2026, 1, 15)


FACTS = {"original": 550000, "homeValue": 800000, "lvr": 68, "ratePct": 5.74, "baseRepay": 3000, "extra": 0}
BALANCE = {"balance": Decimal("500000"), "as_at": "2026-01-10"}


class FakeMilestoneRepo:
    def __init__(self, milestones):
        self._milestones = milestones

    def get_milestones(self, scope="SHARED"):
        return list(self._milestones)


class FakeLoanFactsRepo:
    def get_loanfacts(self):
        return dict(FACTS)


class FakeHomeLoanRepo:
    def __init__(self, balance=BALANCE):
        self._balance = balance

    def get_balance(self, account_id):
        return dict(self._balance)


def _event():
    return {"rawPath": "/milestones/review", "requestContext": {"http": {"method": "POST"}}, "body": ""}


def _review(handler, monkeypatch, stored, pacing, capture=None, balance=BALANCE):
    """Run review_milestones with review_pacing stubbed to `pacing` and today pinned."""
    def fake(model_input):
        if capture is not None:
            capture["model_input"] = model_input
        return pacing
    monkeypatch.setattr(handler, "date", FixedDate)
    monkeypatch.setattr(handler, "review_pacing", fake)
    resp = handler.review_milestones(
        _event(), FakeMilestoneRepo(stored), FakeHomeLoanRepo(balance), FakeLoanFactsRepo())
    return resp["statusCode"], json.loads(resp["body"])


def _no_ai(handler, monkeypatch):
    monkeypatch.setattr(handler, "date", FixedDate)
    monkeypatch.setattr(handler, "review_pacing",
                        lambda _mi: (_ for _ in ()).throw(AssertionError("no AI call")))


# WHIT-371 — [G1] target exactly == current balance is skipped (locks `>= balance`)
def test_target_exactly_equal_to_balance_is_skipped(handler, monkeypatch):
    # The 500k milestone equals the live balance AND is overdue (targetDate 2025), so the ONLY
    # thing that can exclude it is the `>=` balance filter — not the behind-threshold. If the
    # filter were `>` it would leak into the candidates (projected 2026-01, 12 months behind).
    cap = {}
    stored = [
        {"id": "eq", "label": "At balance", "targetBalance": 500000, "targetDate": "2025-01-01"},
        {"id": "m1", "label": "Quarter down", "targetBalance": 400000, "targetDate": "2030-01-01"},
    ]
    status, body = _review(handler, monkeypatch, stored,
                           pacing=[{"index": 0, "reason": "behind"}], capture=cap)
    assert status == 200
    targets = {c["targetBalance"] for c in cap["model_input"]["milestones"]}
    assert targets == {400000}   # 500000 (== balance) excluded; only the below-balance one remains
    assert [a["milestoneId"] for a in body["adjustments"]] == ["m1"]


# WHIT-371 — [G2] variance exactly 1 month is flagged (locks the `< 1` threshold, kept side)
def test_exactly_one_month_behind_is_flagged(handler, monkeypatch):
    # 400k is really reached 2036-03-01; planned 2036-02-01 → exactly 1 month behind == the
    # threshold, so it MUST be a candidate. If the threshold were `< 2` it'd be dropped.
    cap = {}
    stored = [{"id": "m1", "label": "Quarter down", "targetBalance": 400000, "targetDate": "2036-02-01"}]
    status, body = _review(handler, monkeypatch, stored,
                           pacing=[{"index": 0, "reason": "just slipping"}], capture=cap)
    assert status == 200
    assert cap["model_input"]["milestones"][0]["varianceMonths"] == 1
    adj = body["adjustments"][0]
    assert adj["varianceMonths"] == 1
    assert adj["suggestedTargetDate"] == "2036-03-01"


# WHIT-371 — [G3] variance exactly 0 (on track) is skipped, no AI (locks `< 1`, dropped side)
def test_exactly_on_track_zero_variance_is_skipped_no_ai(handler, monkeypatch):
    # Planned date == the real projected date → 0 months behind → NOT an adjustment → honest empty
    # 200 with NO model call. If the threshold were `< 0` this would wrongly become a candidate and
    # trip the no-AI guard.
    _no_ai(handler, monkeypatch)
    stored = [{"id": "m1", "label": "Quarter down", "targetBalance": 400000, "targetDate": "2036-03-01"}]
    resp = handler.review_milestones(
        _event(), FakeMilestoneRepo(stored), FakeHomeLoanRepo(), FakeLoanFactsRepo())
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"adjustments": [], "payoffFeasible": True}


# WHIT-371 — [G4] an overdue (past) targetDate is flagged with a large positive variance
def test_overdue_past_target_date_is_flagged(handler, monkeypatch):
    # A milestone whose planned date is already in the PAST (2020-01-01) — reached 2036-03-01 at the
    # real pace → 194 months behind. No crash, variance stays positive, projected date is ours.
    cap = {}
    stored = [{"id": "m1", "label": "Quarter down", "targetBalance": 400000, "targetDate": "2020-01-01"}]
    status, body = _review(handler, monkeypatch, stored,
                           pacing=[{"index": 0, "reason": "way behind now"}], capture=cap)
    assert status == 200
    assert cap["model_input"]["milestones"][0]["varianceMonths"] == 194   # (2036-2020)*12 + (3-1)
    adj = body["adjustments"][0]
    assert adj["varianceMonths"] == 194
    assert adj["suggestedTargetDate"] == "2036-03-01"
    assert adj["currentTargetDate"] == "2020-01-01"


# WHIT-371 — [G5] mixed plan: only the behind, below-balance milestone reaches the model
def test_mixed_plan_only_behind_below_balance_reaches_model(handler, monkeypatch):
    # cleared (== balance), on-track (planned far AFTER its real date), and behind, all at once →
    # only the behind one is a candidate. Guards the two independent filters firing together.
    cap = {}
    stored = [
        {"id": "cleared", "label": "At balance", "targetBalance": 500000, "targetDate": "2025-01-01"},
        {"id": "behind", "label": "Quarter down", "targetBalance": 400000, "targetDate": "2030-01-01"},
        {"id": "ontrack", "label": "Halfway", "targetBalance": 250000, "targetDate": "2050-01-01"},
    ]
    status, body = _review(handler, monkeypatch, stored,
                           pacing=[{"index": 0, "reason": "drifting"}], capture=cap)
    assert status == 200
    targets = {c["targetBalance"] for c in cap["model_input"]["milestones"]}
    assert targets == {400000}
    assert [a["milestoneId"] for a in body["adjustments"]] == ["behind"]


# WHIT-371 — [G6] per-index scrub isolation: dirty reason dropped, clean sibling survives (no 502)
def test_one_dirty_reason_dropped_clean_sibling_survives(handler, monkeypatch):
    # Two behind milestones. index 0's reason is clean; index 1's reason is all figures and scrubs
    # empty. The scrub is per-index — index 1 is dropped, index 0 survives → 200 (NOT a whole-batch
    # 502). Distinct from the "every reason dirty → 502" case the implementer covers.
    stored = [
        {"id": "m1", "label": "Quarter down", "targetBalance": 400000, "targetDate": "2030-01-01"},
        {"id": "m2", "label": "Halfway", "targetBalance": 250000, "targetDate": "2040-01-01"},
    ]
    status, body = _review(
        handler, monkeypatch, stored,
        pacing=[{"index": 0, "reason": "running behind"}, {"index": 1, "reason": "$ 20 000 50%"}])
    assert status == 200
    assert [a["milestoneId"] for a in body["adjustments"]] == ["m1"]
    assert body["adjustments"][0]["reason"] == "running behind"


# WHIT-389 — [G7] duplicate index: first reason is figures-only, clean twin later → clean twin kept
def test_duplicate_index_prefers_first_clean_reason_over_dirty_twin(handler, monkeypatch):
    # The model returns index 0 twice: first a figures-only reason ("2032"), then a clean one.
    # _first_by_index now prefers the first reason that SURVIVES the scrub, so the clean twin is
    # kept and the milestone recovers with a usable reason instead of falling to a 502 whiff.
    stored = [{"id": "m1", "label": "Quarter down", "targetBalance": 400000, "targetDate": "2030-01-01"}]
    status, body = _review(
        handler, monkeypatch, stored,
        pacing=[{"index": 0, "reason": "2032"}, {"index": 0, "reason": "running behind your plan"}])
    assert status == 200
    assert [a["milestoneId"] for a in body["adjustments"]] == ["m1"]
    assert body["adjustments"][0]["reason"] == "running behind your plan"
