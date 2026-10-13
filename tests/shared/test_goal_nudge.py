"""WHIT-236 — behind-pace nudge detection + send/dedupe (shared/goal_nudge.py).

Fakes for every repo (no DynamoDB); ``send_push`` is stubbed to capture pushes, mirroring
tests/lambda/test_budget_alerts.py. Locks: the "behind" definition (option A — imminent
deadline, still short, not lapsed), the per-(goal, cycle) dedupe + re-arm, mark-on-landing,
the short-circuits, the synced-not-polled skip, and the SIGNED-balance path for a paydown
goal (a positive/abs balance would read as met and never fire — the critic's MAJOR fix).
Fortnightly cycle, paydays land …Jul4, Jul18, Aug1, Aug15; "today" = Sat 11 Jul 2026.
"""

from decimal import Decimal

import pytest

from _goal_nudge_fakes import CYCLE, TODAY, notify_repo, _grow, _manual, _run


# --- is_behind (option A) ----------------------------------------------------

@pytest.mark.parametrize("target_date, remaining, paydays_left, expected", [
    pytest.param("2026-07-18", 6000, 1, True, id="imminent-and-short"),
    pytest.param("2026-07-12", 6000, 0, True, id="zero-paydays-future-target"),
    pytest.param("2026-07-11", 6000, 0, True, id="target-today-is-not-lapsed"),
    pytest.param("2026-06-01", 6000, 0, False, id="lapsed"),
    pytest.param("2026-08-01", 6000, 2, False, id="two-paydays-is-still-far"),
    pytest.param("2026-07-18", 0, 1, False, id="met"),
    pytest.param("2026-07-18", None, 1, False, id="unknown-remaining"),
    pytest.param("not-a-date", 6000, 0, False, id="malformed-date"),
    pytest.param("", 6000, 0, False, id="empty-date"),
])
def test_is_behind(shared, target_date, remaining, paydays_left, expected):
    remaining = Decimal(remaining) if remaining is not None else None
    pace = {"remaining": remaining, "paydays_left": paydays_left}
    assert shared.goal_nudge.is_behind(_grow(target_date=target_date), pace, TODAY) is expected


# --- is_stale (WHIT-259 Part 2) ----------------------------------------------

@pytest.mark.parametrize("goal, expected", [
    pytest.param(_manual(manual_as_of="2026-06-11"), False, id="exactly-30-days"),
    pytest.param(_manual(manual_as_of="2026-06-10"), True, id="31-days"),
    pytest.param(_manual(manual_as_of=None), False, id="none"),
    pytest.param(_manual(manual_as_of="not-a-date"), False, id="unparseable"),
    pytest.param(_manual(manual_as_of=20260501), False, id="non-string"),
    pytest.param(_manual(manual_as_of="2027-01-01"), False, id="future"),
    # an account-linked goal refreshes itself; even an old manual_as_of never makes it stale
    pytest.param(_manual(account_id="up-spending", manual_as_of="2026-01-01"), False, id="synced"),
])
def test_is_stale(shared, goal, expected):
    assert shared.goal_nudge.is_stale(goal, TODAY) is expected


# --- notify_behind_goals -----------------------------------------------------

class TestNotifyBehindGoals:
    def test_behind_grow_fires_one_push_with_copy(self, shared, monkeypatch):
        sent, rec, notify, *_ = _run(shared, monkeypatch, {"g1": _grow()},
                                     balances={"up-spending": Decimal(4000)})
        assert sent == 1
        # remaining 6000 over 1 payday -> $6,000/payday; target month July.
        assert rec.calls[0]["body"] == "Your Holiday fund needs $6,000/payday to hit July."
        assert "GOAL#g1" in notify.fired_markers(CYCLE["last_pay_date"], CYCLE["length"])

    def test_behind_push_carries_goal_deeplink_data(self, shared, monkeypatch):
        # WHIT-322: the push carries data={"type": "goal"} so a tap opens the goals screen.
        _, rec, *_ = _run(shared, monkeypatch, {"g1": _grow()},
                          balances={"up-spending": Decimal(4000)})
        assert rec.calls[0]["data"] == {"type": "goal"}

    def test_manual_behind_fires(self, shared, monkeypatch):
        goal = _grow(account_id=None, manual_balance=Decimal(4000))
        sent, rec, *_ = _run(shared, monkeypatch, {"m1": goal})
        assert sent == 1

    def test_signed_paydown_fires(self, shared, monkeypatch):
        # SIGNED balance -6000 -> owed 6000 -> behind. An ABS/positive source would read
        # owed max(0,-6000)=0 -> met -> never fire (the critic's MAJOR fail-on-revert).
        debt = {"name": "Car loan", "direction": "paydown", "target_amount": Decimal(0),
                "target_date": "2026-07-18", "account_id": "up-homeloan"}
        sent, rec, *_ = _run(shared, monkeypatch, {"d1": debt},
                             balances={"up-homeloan": Decimal(-6000)})
        assert sent == 1
        assert rec.calls[0]["body"] == "Your Car loan needs $6,000/payday to hit July."

    def test_dedupe_same_cycle_does_not_resend(self, shared, monkeypatch):
        notify = notify_repo()
        notify.mark_fired(CYCLE["last_pay_date"], CYCLE["length"], "GOAL#g1")
        sent, rec, *_ = _run(shared, monkeypatch, {"g1": _grow()},
                             balances={"up-spending": Decimal(4000)}, notify=notify)
        assert sent == 0
        assert rec.calls == []

    def test_rearm_next_cycle_resends(self, shared, monkeypatch):
        notify = notify_repo()
        s1, *_ = _run(shared, monkeypatch, {"g1": _grow()},
                      balances={"up-spending": Decimal(4000)}, notify=notify)
        # A new pay cycle (different last_pay_date) -> new marker key -> re-arms.
        new_cycle = {"length": 14, "last_pay_date": "2026-06-20"}
        s2, *_ = _run(shared, monkeypatch, {"g1": _grow()},
                      balances={"up-spending": Decimal(4000)}, notify=notify, cycle=new_cycle)
        assert s1 == 1 and s2 == 1

    def test_mark_on_landing_send_fails_then_retries(self, shared, monkeypatch):
        notify = notify_repo()
        # First sweep: Expo outage (ok=0) -> not marked -> not counted.
        s1, *_ = _run(shared, monkeypatch, {"g1": _grow()},
                      balances={"up-spending": Decimal(4000)}, notify=notify, send_ok=0)
        assert s1 == 0
        assert notify.fired_markers(CYCLE["last_pay_date"], CYCLE["length"]) == set()
        # Next sweep in the same cycle re-sends and lands.
        s2, *_ = _run(shared, monkeypatch, {"g1": _grow()},
                      balances={"up-spending": Decimal(4000)}, notify=notify, send_ok=1)
        assert s2 == 1

    def test_synced_not_polled_is_skipped(self, shared, monkeypatch):
        # behind by the numbers, but no balance row yet -> never a false nudge.
        sent, rec, *_ = _run(shared, monkeypatch, {"g1": _grow()}, balances={})
        assert sent == 0
        assert rec.calls == []


# --- stale trigger inside notify_behind_goals --------------------------------

class TestStaleNudge:
    def test_stale_manual_fires_one_push_with_copy(self, shared, monkeypatch):
        sent, rec, notify, *_ = _run(shared, monkeypatch, {"m1": _manual()})
        assert sent == 1
        assert rec.calls[0]["body"] == "Your Car savings balance is 71 days old — tap to update."
        assert "GOAL#m1#stale" in notify.fired_markers(CYCLE["last_pay_date"], CYCLE["length"])

    def test_stale_push_carries_goal_deeplink_data(self, shared, monkeypatch):
        # WHIT-322 GAP — the STALE nudge is a second, conceptually-distinct send site that also
        # flows through send_and_mark, so it must ALSO carry data={"type": "goal"}. The
        # implementer only locked the behind-pace push; a stale-only data regression would slip
        # past that. _manual() defaults are stale-but-not-behind, so this is the pure stale path.
        _, rec, *_ = _run(shared, monkeypatch, {"m1": _manual()})
        assert rec.calls[0]["title"] == shared.goal_nudge._STALE_TITLE  # proves it's the stale push
        assert rec.calls[0]["data"] == {"type": "goal"}


    def test_stale_fires_even_when_behind_marker_already_set(self, shared, monkeypatch):
        # The behind marker fired earlier this cycle; stale is independent and must STILL fire.
        # (Fail-on-revert for the per-trigger marker split — a single shared guard would swallow
        # this.) target_date near so the goal is also behind, its behind marker pre-seeded.
        notify = notify_repo()
        notify.mark_fired(CYCLE["last_pay_date"], CYCLE["length"], "GOAL#m1")
        goal = _manual(target_date="2026-07-18")  # behind AND stale
        sent, rec, notify, *_ = _run(shared, monkeypatch, {"m1": goal}, notify=notify)
        assert sent == 1
        assert rec.calls[0]["title"] == shared.goal_nudge._STALE_TITLE
        markers = notify.fired_markers(CYCLE["last_pay_date"], CYCLE["length"])
        assert "GOAL#m1#stale" in markers


    def test_stale_dedupe_same_cycle(self, shared, monkeypatch):
        notify = notify_repo()
        notify.mark_fired(CYCLE["last_pay_date"], CYCLE["length"], "GOAL#m1#stale")
        sent, rec, *_ = _run(shared, monkeypatch, {"m1": _manual()}, notify=notify)
        assert sent == 0
        assert rec.calls == []


# --- folded from test_goal_nudge_edges.py (WHIT-463) ---


class TestCopyHelpers:

    def test_month_of_falls_back_on_broken_date(self, shared):
        # [A31] month index out of range / unparseable -> graceful fallback, no crash.
        assert shared.goal_nudge._month_of("2026-13-01") == "your target date"
        assert shared.goal_nudge._month_of("") == "your target date"


    def test_format_pace_rounds_half_up_like_the_client(self, shared):
        # WHIT-236 F1: an exact half-dollar must round HALF-UP (Decimal('120.50') -> '121'),
        # matching the client's Math.round — NOT Decimal's default banker's rounding, which
        # would give '120' and disagree with the app's Goal screen by $1.
        assert shared.goal_nudge._format_pace(Decimal("120.50")) == "121"
        assert shared.goal_nudge._format_pace(Decimal("0.50")) == "1"


class TestNotifyMultiAndCollisions:


    def test_budget_marker_in_shared_set_does_not_suppress_goal(self, shared, monkeypatch):
        # [A35] goal_nudge shares the per-cycle FIRED set with budget alerts. A budget
        # "groceries#80" marker present must NOT be mistaken for the goal's "GOAL#g1"
        # marker: the goal still fires, and both markers coexist afterwards.
        notify = notify_repo(seed={(CYCLE["last_pay_date"], CYCLE["length"]): {"groceries#80"}})
        sent, rec, notify, *_ = _run(shared, monkeypatch, {"g1": _grow()},
                                 balances={"up-spending": Decimal(4000)}, notify=notify)
        assert sent == 1
        assert notify.fired_markers(CYCLE["last_pay_date"], CYCLE["length"]) == {"groceries#80", "GOAL#g1"}


# --- folded from test_goal_nudge_gaps.py (WHIT-463) ---


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


    def test_stale_already_fired_behind_still_fires(self, shared, monkeypatch):
        # WHIT-259 — the SYMMETRIC independence case the implementer's suite omits: the STALE marker
        # is already set this cycle, so only the BEHIND trigger may fire on the same goal. A single
        # shared guard (or a marker collapse) would swallow it.
        notify = notify_repo()
        notify.mark_fired(CYCLE["last_pay_date"], CYCLE["length"], "GOAL#m1#stale")
        goal = _manual(target_date="2026-07-18")  # behind AND stale
        sent, rec, notify, *_ = _run(shared, monkeypatch, {"m1": goal}, notify=notify)
        assert sent == 1
        assert rec.calls[0]["title"] == shared.goal_nudge._TITLE
        assert notify.fired_markers(CYCLE["last_pay_date"], CYCLE["length"]) == {
            "GOAL#m1#stale", "GOAL#m1"}
