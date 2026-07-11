"""WHIT-236 — adversarial gaps in the nudge send/dedupe logic (shared/goal_nudge.py) that
the implementer's test_goal_nudge.py leaves open:
 - is_behind cliff boundary (paydays_left ==1 fires vs ==2 doesn't) + target==today +
   malformed target_date,
 - _month_of fallback on a broken date,
 - _format_pace on a non-integer pace,
 - a MULTI-goal sweep where only the behind goals fire and each is marked independently,
 - the SHARED FIRED partition collision: a budget "groceries#80" marker must NOT suppress
   a "GOAL#..." nudge (goal_nudge writes into the same per-cycle set budget_alerts reads),
 - a stale marker for a since-deleted goal is harmless.
Fortnightly cycle, paydays land …Jul4, Jul18, Aug1, Aug15; today = Sat 11 Jul 2026.
"""

from decimal import Decimal

from _goal_nudge_fakes import CYCLE, TODAY, FakeNotifyRepo, _grow, _run


# --- is_behind: the <=1 cliff + date boundaries ------------------------------

class TestIsBehindBoundaries:
    def test_exactly_one_payday_left_is_behind(self, shared):
        # [A27] paydays_left == 1 is the last cycle before the deadline -> fires.
        assert shared.goal_nudge.is_behind(
            _grow(), {"remaining": Decimal(6000), "paydays_left": 1}, TODAY) is True

    def test_exactly_two_paydays_left_is_not_behind(self, shared):
        # [A28] the cliff: 2 paydays out is still "far" -> must NOT fire.
        assert shared.goal_nudge.is_behind(
            _grow(target_date="2026-08-01"), {"remaining": Decimal(6000), "paydays_left": 2}, TODAY) is False

    def test_target_date_equal_today_is_behind(self, shared):
        # [A29] deadline is today: today is NOT < today, so it's not lapsed -> fires.
        assert shared.goal_nudge.is_behind(
            _grow(target_date="2026-07-11"), {"remaining": Decimal(6000), "paydays_left": 0}, TODAY) is True

    def test_malformed_target_date_is_not_behind(self, shared):
        # [A30] an unparseable/empty target_date can't be judged -> never a false nudge.
        assert shared.goal_nudge.is_behind(
            _grow(target_date="not-a-date"), {"remaining": Decimal(6000), "paydays_left": 0}, TODAY) is False
        assert shared.goal_nudge.is_behind(
            _grow(target_date=""),
            {"remaining": Decimal(6000), "paydays_left": 0}, TODAY) is False


# --- copy helpers ------------------------------------------------------------

class TestCopyHelpers:
    def test_month_of_reads_month(self, shared):
        assert shared.goal_nudge._month_of("2026-12-01") == "December"

    def test_month_of_falls_back_on_broken_date(self, shared):
        # [A31] month index out of range / unparseable -> graceful fallback, no crash.
        assert shared.goal_nudge._month_of("2026-13-01") == "your target date"
        assert shared.goal_nudge._month_of("") == "your target date"

    def test_format_pace_non_integer_rounds_to_whole_dollars(self, shared):
        # [A32] 8000/3 = 2666.66 -> "2,667" (whole dollars, thousands separator).
        assert shared.goal_nudge._format_pace(Decimal(8000) / Decimal(3)) == "2,667"

    def test_format_pace_rounds_half_up_like_the_client(self, shared):
        # WHIT-236 F1: an exact half-dollar must round HALF-UP (Decimal('120.50') -> '121'),
        # matching the client's Math.round — NOT Decimal's default banker's rounding, which
        # would give '120' and disagree with the app's Goal screen by $1.
        assert shared.goal_nudge._format_pace(Decimal("120.50")) == "121"
        assert shared.goal_nudge._format_pace(Decimal("0.50")) == "1"


# --- notify_behind_goals: multi-goal + shared-partition collisions -----------

class TestNotifyMultiAndCollisions:
    def test_only_behind_goals_fire_in_a_mixed_sweep(self, shared, monkeypatch):
        # [A33] three goals: one behind (imminent+short), one far, one met. Only the
        # behind one fires and only its marker is written.
        goals = {
            "behind": _grow(name="Behind", target_date="2026-07-18"),   # 1 payday, short
            "far": _grow(name="Far", target_date="2026-08-15"),          # 3 paydays
            "met": _grow(name="Met", target_date="2026-07-18"),          # balance >= target
        }
        balances = {"up-spending": Decimal(4000)}  # shared account; met overrides below
        goals["met"]["account_id"] = "met-acct"
        balances["met-acct"] = Decimal(10000)
        sent, rec, notify, *_ = _run(shared, monkeypatch, goals, balances=balances)
        assert sent == 1
        assert [c["body"] for c in rec.calls] == ["Your Behind needs $6,000/payday to hit July."]
        markers = notify.fired_markers(CYCLE["last_pay_date"], CYCLE["length"])
        assert markers == {"GOAL#behind"}

    def test_two_behind_goals_fire_distinct_markers(self, shared, monkeypatch):
        # [A34] two independently-behind goals -> two pushes, two distinct markers.
        goals = {
            "g1": _grow(name="Alpha", target_date="2026-07-18", account_id="a1"),
            "g2": _grow(name="Beta", target_date="2026-07-18", account_id="a2"),
        }
        sent, rec, notify, *_ = _run(shared, monkeypatch, goals,
                                 balances={"a1": Decimal(4000), "a2": Decimal(4000)})
        assert sent == 2
        assert notify.fired_markers(CYCLE["last_pay_date"], CYCLE["length"]) == {"GOAL#g1", "GOAL#g2"}

    def test_budget_marker_in_shared_set_does_not_suppress_goal(self, shared, monkeypatch):
        # [A35] goal_nudge shares the per-cycle FIRED set with budget alerts. A budget
        # "groceries#80" marker present must NOT be mistaken for the goal's "GOAL#g1"
        # marker: the goal still fires, and both markers coexist afterwards.
        notify = FakeNotifyRepo(seed={(CYCLE["last_pay_date"], CYCLE["length"]): {"groceries#80"}})
        sent, rec, notify, *_ = _run(shared, monkeypatch, {"g1": _grow()},
                                 balances={"up-spending": Decimal(4000)}, notify=notify)
        assert sent == 1
        assert notify.fired_markers(CYCLE["last_pay_date"], CYCLE["length"]) == {"groceries#80", "GOAL#g1"}

    def test_stale_marker_for_deleted_goal_is_harmless(self, shared, monkeypatch):
        # [A36] a leftover "GOAL#gone" marker for a goal that no longer exists neither
        # fires nor errors; the live behind goal still fires normally.
        notify = FakeNotifyRepo(seed={(CYCLE["last_pay_date"], CYCLE["length"]): {"GOAL#gone"}})
        sent, rec, notify, *_ = _run(shared, monkeypatch, {"g1": _grow()},
                                 balances={"up-spending": Decimal(4000)}, notify=notify)
        assert sent == 1
        assert "GOAL#g1" in notify.fired_markers(CYCLE["last_pay_date"], CYCLE["length"])
