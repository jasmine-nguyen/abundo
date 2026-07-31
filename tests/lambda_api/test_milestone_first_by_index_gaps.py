"""WHIT-389 adversarial GAP coverage for the shared `_first_by_index` helper.

The implementer's 3 tests lock the core recovery (dirty-then-clean twin kept) + the all-dirty
502 fallback on the SUGGEST side, and the review dirty-then-clean twin on the REVIEW side. These
add the edges those leave open, each proven by fail-on-revert against a naive first-seen helper:

  [A-S1] triple twin (dirty, dirty, clean) on one index          → clean twin kept, 200
  [A-S2] (dirty, clean, clean) — FIRST surviving twin wins, later clean twin ignored
  [A-S3] a clean-but-over-max_len twin then a short clean twin    → short wins (max_len threading)
  [A-S4] a None / non-str first twin then a clean twin            → clean wins, 200
  [G8]   two DISTINCT indices, each with its own dirty→clean twin → each resolved independently
  [G10]  a whitespace-only first twin then a clean twin (review)  → clean wins, 200

Harness mirrors the two sibling suites: `handler` fixture, pinned FixedDate, stubbed pacing.
"""

import datetime
import json
from decimal import Decimal

import pytest


class FixedDate(datetime.date):
    @classmethod
    def today(cls):
        return datetime.date(2026, 1, 15)


# --- suggest harness (mirrors test_milestone_suggest_adversarial.py) ----------

_S_FACTS = {"ratePct": 5.74, "baseRepay": 3000, "termYears": 30, "lender": "Up"}
_S_BALANCE = {"balance": Decimal("500000"), "as_at": "2026-01-10"}


class _SFakeLoanFactsRepo:
    def get_loanfacts(self):
        return dict(_S_FACTS)


class _SFakeHomeLoanRepo:
    def get_balance(self, account_id):
        return dict(_S_BALANCE)


def _suggest(handler, monkeypatch, pacing):
    monkeypatch.setattr(handler, "date", FixedDate)
    monkeypatch.setattr(handler, "suggest_pacing", lambda _mi: pacing)
    event = {
        "rawPath": "/milestones/suggest",
        "requestContext": {"http": {"method": "POST"}},
        "body": json.dumps({"targetDate": "2035-06-01", "extraMonthly": 0}),
        "isBase64Encoded": False,
    }
    resp = handler.suggest_milestones(event, _SFakeHomeLoanRepo(), _SFakeLoanFactsRepo())
    return resp["statusCode"], json.loads(resp["body"])


# --- review harness (mirrors test_milestone_review_gaps.py) -------------------

_R_FACTS = {"original": 550000, "homeValue": 800000, "lvr": 68,
            "ratePct": 5.74, "baseRepay": 3000, "extra": 0}
_R_BALANCE = {"balance": Decimal("500000"), "as_at": "2026-01-10"}


class _RFakeMilestoneRepo:
    def __init__(self, milestones):
        self._milestones = milestones

    def get_milestones(self, scope="SHARED"):
        return list(self._milestones)


class _RFakeLoanFactsRepo:
    def get_loanfacts(self):
        return dict(_R_FACTS)


class _RFakeHomeLoanRepo:
    def get_balance(self, account_id):
        return dict(_R_BALANCE)


def _review(handler, monkeypatch, stored, pacing):
    monkeypatch.setattr(handler, "date", FixedDate)
    monkeypatch.setattr(handler, "review_pacing", lambda _mi: pacing)
    event = {"rawPath": "/milestones/review",
             "requestContext": {"http": {"method": "POST"}}, "body": ""}
    resp = handler.review_milestones(
        event, _RFakeMilestoneRepo(stored), _RFakeHomeLoanRepo(), _RFakeLoanFactsRepo())
    return resp["statusCode"], json.loads(resp["body"])


# =====================================================================================
# SUGGEST-side gaps
# =====================================================================================

# WHIT-389 — [A-S1] three twins on one index (dirty, dirty, clean) → the clean one still wins.
def test_triple_twin_dirty_dirty_clean_keeps_clean_label(handler, monkeypatch):
    # The implementer only proves a 2-twin (dirty, clean) recovery. With TWO leading dirty twins the
    # `survived` set must still let the trailing clean twin overwrite them. Naive first-seen keeps
    # "2032" → scrubs empty → 502; the new helper keeps "Halfway" → 200.
    status, body = _suggest(
        handler, monkeypatch,
        pacing=[{"index": 3, "label": "2032"},
                {"index": 3, "label": "$50 000"},
                {"index": 3, "label": "Halfway"}])
    assert status == 200
    assert [m["label"] for m in body["milestones"]] == ["Halfway"]


# WHIT-389 — [A-S2] (dirty, clean, clean): the FIRST surviving twin wins, later clean twin ignored.
def test_first_surviving_label_wins_later_clean_twin_ignored(handler, monkeypatch):
    # Locks the "first value that survives" rule on BOTH sides at once: the leading dirty twin is
    # skipped, the FIRST clean twin ("Onwards") is kept, and the SECOND clean twin ("Later") must be
    # ignored (the `survived` set short-circuits it). Naive first-seen keeps the dirty "2032" → 502,
    # so this is red on revert; and if the rule flipped to "last clean wins" the label would read
    # "Later", so it also guards ordering.
    status, body = _suggest(
        handler, monkeypatch,
        pacing=[{"index": 3, "label": "2032"},
                {"index": 3, "label": "Onwards"},
                {"index": 3, "label": "Later"}])
    assert status == 200
    assert [m["label"] for m in body["milestones"]] == ["Onwards"]


# WHIT-389 — [A-S3] a clean-but-too-long twin does NOT survive; the short twin wins (max_len threaded).
def test_over_max_len_clean_label_does_not_survive_short_twin_wins(handler, monkeypatch):
    # The long label scrubs to ~164 chars — clean words, but over the 100-char LABEL cap, so the
    # survive-check (max_len=100) rejects it and the short "Halfway" twin is kept → 200. This is the
    # test that proves max_len must be threaded PER endpoint: if the helper were handed the reason
    # cap (200) instead, the 164-char twin would "survive", be kept, then fail the label scrub
    # downstream → 502. Naive first-seen also keeps the long twin → 502. Either bug is red here.
    long_label = "keep it up " * 15  # ~164 chars, no figures → survives at 200, not at 100
    assert 100 < len(long_label.strip()) < 200
    status, body = _suggest(
        handler, monkeypatch,
        pacing=[{"index": 3, "label": long_label}, {"index": 3, "label": "Halfway"}])
    assert status == 200
    assert [m["label"] for m in body["milestones"]] == ["Halfway"]


# WHIT-389 — [A-S4] a None / non-str first twin can't survive; the clean twin wins.
@pytest.mark.parametrize("bad_first", [None, 12345, {"nested": "label"}])
def test_none_or_nonstr_first_twin_does_not_survive_clean_wins(handler, monkeypatch, bad_first):
    # `_scrub_figures` returns None for any non-str, so a None / int / dict first twin cannot
    # "survive" and must not block the clean twin. Naive first-seen keeps the bad value → the
    # downstream label scrub returns None → the milestone drops → 502.
    status, body = _suggest(
        handler, monkeypatch,
        pacing=[{"index": 3, "label": bad_first}, {"index": 3, "label": "Halfway"}])
    assert status == 200
    assert [m["label"] for m in body["milestones"]] == ["Halfway"]


# =====================================================================================
# REVIEW-side gaps
# =====================================================================================

# WHIT-389 — [G8] two distinct indices, each with its own dirty→clean twin, resolved independently.
def test_multiple_indices_each_resolve_their_own_clean_twin(handler, monkeypatch):
    # Both stored milestones are behind (candidates 0 and 1). The model returns a dirty twin THEN a
    # clean twin for EACH index, interleaved. The helper must recover both independently in one call.
    # Naive first-seen keeps "2032"/"99 %" for both → both reasons scrub empty → no adjustments → 502.
    stored = [
        {"id": "m1", "label": "Quarter down", "targetBalance": 400000, "targetDate": "2030-01-01"},
        {"id": "m2", "label": "Halfway", "targetBalance": 250000, "targetDate": "2040-01-01"},
    ]
    status, body = _review(
        handler, monkeypatch, stored,
        pacing=[{"index": 0, "reason": "2032"},
                {"index": 1, "reason": "99 %"},
                {"index": 0, "reason": "drifting behind"},
                {"index": 1, "reason": "slipping later"}])
    assert status == 200
    got = {a["milestoneId"]: a["reason"] for a in body["adjustments"]}
    assert got == {"m1": "drifting behind", "m2": "slipping later"}


# WHIT-389 — [G10] a whitespace-only first twin can't survive; the clean twin wins (review side).
def test_whitespace_only_reason_twin_does_not_survive_clean_wins(handler, monkeypatch):
    # Distinct scrub-to-None path from the "figures-only" twin the implementer covers: "   \t\n"
    # collapses to "" → None → does not survive. The clean twin is kept → 200. Naive first-seen keeps
    # the blank → reason scrubs empty → no adjustments → 502.
    stored = [{"id": "m1", "label": "Quarter down", "targetBalance": 400000, "targetDate": "2030-01-01"}]
    status, body = _review(
        handler, monkeypatch, stored,
        pacing=[{"index": 0, "reason": "   \t\n  "},
                {"index": 0, "reason": "running behind your plan"}])
    assert status == 200
    assert [a["milestoneId"] for a in body["adjustments"]] == ["m1"]
    assert body["adjustments"][0]["reason"] == "running behind your plan"
