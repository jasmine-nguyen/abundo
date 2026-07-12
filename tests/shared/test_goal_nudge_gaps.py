"""WHIT-259 Part 2 — adversarial GAPS the implementer's test_goal_nudge.py / _edges leave open.

The implementer already locked: is_stale happy/boundary (30 vs 31)/synced/missing/None/unparseable,
the two-trigger independence (behind-marker-set → stale still fires), outage-leaves-unmarked,
stale dedupe, and the behind-only regression. These are the NON-duplicative extras:
 - a FUTURE manual_as_of (user typed a date ahead) → not stale, no crash;
 - a NON-STRING manual_as_of (legacy/raw-DB row) → not stale, no TypeError escaping the sweep;
 - a MIXED sweep (one stale-only manual + one behind-only synced) counts the two triggers
   independently across different goals;
 - the stale push body falls back to "goal" when name is blank;
 - a stale nudge coexists with a budget "<cat>#<pct>" marker in the SHARED FIRED set;
 - the SYMMETRIC independence case the implementer omitted: stale marker already set → the
   behind trigger on the SAME goal must still fire.
Fortnightly cycle, paydays land …Jul4, Jul18, Aug1, Aug15; today = Sat 11 Jul 2026.
"""

from decimal import Decimal

from _goal_nudge_fakes import CYCLE, TODAY, FakeNotifyRepo, _grow, _manual, _run


# --- is_stale: the future-date + non-string edges ----------------------------

class TestIsStaleFuture:
    def test_future_manual_as_of_is_not_stale(self, shared):
        # WHIT-259 — a user who set a balance date AHEAD of today (diff is negative) must not be
        # judged stale, and must not crash. Guards against a naive abs(diff) > 30 implementation.
        goal = _manual(manual_as_of="2027-01-01")  # ~174 days in the future
        assert shared.goal_nudge.is_stale(goal, TODAY) is False

    def test_non_string_manual_as_of_is_not_stale(self, shared):
        # WHIT-259 — a non-string manual_as_of (legacy/raw-DB int) must be treated as unparseable,
        # not raise a TypeError that would kill the whole best-effort sweep. Locks the
        # (ValueError, TypeError) guard against the docstring's "unparseable → never stale".
        assert shared.goal_nudge.is_stale(_manual(manual_as_of=20260501), TODAY) is False


# --- notify_behind_goals: stale-path gaps -----------------------------------

class TestStaleNudgeGaps:
    def test_mixed_sweep_stale_and_behind_count_independently(self, shared, monkeypatch):
        # WHIT-259 — one stale-only manual goal + one behind-only synced goal in one sweep. Each
        # trigger fires once on its own goal → sent == 2, one stale marker + one behind marker,
        # and NO stale marker leaks onto the synced goal.
        goals = {
            "sm": _manual(name="Car savings"),                       # stale, far target (not behind)
            "bg": _grow(name="Holiday", target_date="2026-07-18"),   # behind, synced (never stale)
        }
        sent, rec, notify, *_ = _run(
            shared, monkeypatch, goals, balances={"up-spending": Decimal(4000)})
        assert sent == 2
        titles = {c["title"] for c in rec.calls}
        assert titles == {shared.goal_nudge._STALE_TITLE, shared.goal_nudge._TITLE}
        assert notify.fired_markers(CYCLE["last_pay_date"], CYCLE["length"]) == {
            "GOAL#sm#stale", "GOAL#bg"}

    def test_stale_push_body_falls_back_when_name_blank(self, shared, monkeypatch):
        # WHIT-259 — a goal saved with an empty name must not render "Your  balance is…". The body
        # uses `goal.get("name") or "goal"`, so it reads "Your goal balance is 71 days old".
        sent, rec, *_ = _run(shared, monkeypatch, {"m1": _manual(name="")})
        assert sent == 1
        assert rec.calls[0]["body"] == "Your goal balance is 71 days old — tap to update."

    def test_stale_coexists_with_budget_marker_in_shared_set(self, shared, monkeypatch):
        # WHIT-259 — the stale marker lives in the SAME per-cycle FIRED set as budget alerts'
        # "<cat>#<pct>" markers. A pre-existing "groceries#80" must not be mistaken for the stale
        # marker: the stale nudge still fires and both markers coexist afterwards.
        notify = FakeNotifyRepo(seed={(CYCLE["last_pay_date"], CYCLE["length"]): {"groceries#80"}})
        sent, rec, notify, *_ = _run(shared, monkeypatch, {"m1": _manual()}, notify=notify)
        assert sent == 1
        assert notify.fired_markers(CYCLE["last_pay_date"], CYCLE["length"]) == {
            "groceries#80", "GOAL#m1#stale"}

    def test_stale_already_fired_behind_still_fires(self, shared, monkeypatch):
        # WHIT-259 — the SYMMETRIC independence case the implementer's suite omits: the STALE marker
        # is already set this cycle, so only the BEHIND trigger may fire on the same goal. A single
        # shared guard (or a marker collapse) would swallow it.
        notify = FakeNotifyRepo()
        notify.mark_fired(CYCLE["last_pay_date"], CYCLE["length"], "GOAL#m1#stale")
        goal = _manual(target_date="2026-07-18")  # behind AND stale
        sent, rec, notify, *_ = _run(shared, monkeypatch, {"m1": goal}, notify=notify)
        assert sent == 1
        assert rec.calls[0]["title"] == shared.goal_nudge._TITLE
        assert notify.fired_markers(CYCLE["last_pay_date"], CYCLE["length"]) == {
            "GOAL#m1#stale", "GOAL#m1"}
