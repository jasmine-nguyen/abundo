"""WHIT-236 — behind-pace nudge detection + send/dedupe (shared/goal_nudge.py).

Fakes for every repo (no DynamoDB); ``send_push`` is stubbed to capture pushes, mirroring
tests/lambda/test_repayment_alerts.py. Locks: the "behind" definition (option A — imminent
deadline, still short, not lapsed), the per-(goal, cycle) dedupe + re-arm, mark-on-landing,
the short-circuits, the synced-not-polled skip, and the SIGNED-balance path for a paydown
goal (a positive/abs balance would read as met and never fire — the critic's MAJOR fix).
Fortnightly cycle, paydays land …Jul4, Jul18, Aug1, Aug15; "today" = Sat 11 Jul 2026.
"""

from decimal import Decimal

from _goal_nudge_fakes import CYCLE, TODAY, FakeNotifyRepo, _grow, _manual, _run


# --- is_behind (option A) ----------------------------------------------------

class TestIsBehind:
    def test_imminent_and_short_is_behind(self, shared):
        goal = _grow()  # target_date Jul18 -> 1 payday left
        pace = {"remaining": Decimal(6000), "paydays_left": 1}
        assert shared.goal_nudge.is_behind(goal, pace, TODAY) is True

    def test_zero_paydays_but_future_target_is_behind(self, shared):
        # deadline before the next payday (0 paydays in the window) but not yet passed.
        goal = _grow(target_date="2026-07-12")
        pace = {"remaining": Decimal(6000), "paydays_left": 0}
        assert shared.goal_nudge.is_behind(goal, pace, TODAY) is True

    def test_lapsed_deadline_is_not_behind(self, shared):
        goal = _grow(target_date="2026-06-01")  # already passed
        pace = {"remaining": Decimal(6000), "paydays_left": 0}
        assert shared.goal_nudge.is_behind(goal, pace, TODAY) is False

    def test_far_deadline_is_not_behind(self, shared):
        goal = _grow(target_date="2026-08-15")
        pace = {"remaining": Decimal(6000), "paydays_left": 3}
        assert shared.goal_nudge.is_behind(goal, pace, TODAY) is False

    def test_met_goal_is_not_behind(self, shared):
        goal = _grow()
        assert shared.goal_nudge.is_behind(goal, {"remaining": Decimal(0), "paydays_left": 1}, TODAY) is False

    def test_unknown_remaining_is_not_behind(self, shared):
        goal = _grow()
        assert shared.goal_nudge.is_behind(goal, {"remaining": None, "paydays_left": 1}, TODAY) is False


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
        notify = FakeNotifyRepo()
        notify.mark_fired(CYCLE["last_pay_date"], CYCLE["length"], "GOAL#g1")
        sent, rec, *_ = _run(shared, monkeypatch, {"g1": _grow()},
                             balances={"up-spending": Decimal(4000)}, notify=notify)
        assert sent == 0
        assert rec.calls == []

    def test_rearm_next_cycle_resends(self, shared, monkeypatch):
        notify = FakeNotifyRepo()
        s1, *_ = _run(shared, monkeypatch, {"g1": _grow()},
                      balances={"up-spending": Decimal(4000)}, notify=notify)
        # A new pay cycle (different last_pay_date) -> new marker key -> re-arms.
        new_cycle = {"length": 14, "last_pay_date": "2026-06-20"}
        s2, *_ = _run(shared, monkeypatch, {"g1": _grow()},
                      balances={"up-spending": Decimal(4000)}, notify=notify, cycle=new_cycle)
        assert s1 == 1 and s2 == 1

    def test_mark_on_landing_send_fails_then_retries(self, shared, monkeypatch):
        notify = FakeNotifyRepo()
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

    def test_far_deadline_does_not_fire(self, shared, monkeypatch):
        sent, *_ = _run(shared, monkeypatch, {"g1": _grow(target_date="2026-08-15")},
                        balances={"up-spending": Decimal(4000)})
        assert sent == 0

    def test_met_goal_does_not_fire(self, shared, monkeypatch):
        sent, *_ = _run(shared, monkeypatch, {"g1": _grow()},
                        balances={"up-spending": Decimal(10000)})
        assert sent == 0

    def test_no_goals_short_circuits_before_devices(self, shared, monkeypatch):
        sent, rec, notify, device, paycycle, _ = _run(shared, monkeypatch, {})
        assert sent == 0
        assert device.calls == 0  # never even read tokens
        assert paycycle.calls == 0

    def test_no_tokens_short_circuits_before_paycycle(self, shared, monkeypatch):
        sent, rec, notify, device, paycycle, _ = _run(
            shared, monkeypatch, {"g1": _grow()}, balances={"up-spending": Decimal(4000)}, tokens=())
        assert sent == 0
        assert paycycle.calls == 0


# --- is_stale (WHIT-259 Part 2) ----------------------------------------------

class TestIsStale:
    def test_old_manual_balance_is_stale(self, shared):
        assert shared.goal_nudge.is_stale(_manual(), TODAY) is True  # 71 days old

    def test_synced_goal_is_never_stale(self, shared):
        # An account-linked goal refreshes itself; even an old manual_as_of never makes it stale.
        goal = _manual(account_id="up-spending", manual_as_of="2026-01-01")
        assert shared.goal_nudge.is_stale(goal, TODAY) is False

    def test_recent_manual_balance_is_not_stale(self, shared):
        assert shared.goal_nudge.is_stale(_manual(manual_as_of="2026-07-01"), TODAY) is False

    def test_exactly_30_days_is_not_stale(self, shared):
        assert shared.goal_nudge.is_stale(_manual(manual_as_of="2026-06-11"), TODAY) is False

    def test_31_days_is_stale(self, shared):
        assert shared.goal_nudge.is_stale(_manual(manual_as_of="2026-06-10"), TODAY) is True

    def test_missing_manual_as_of_is_not_stale(self, shared):
        goal = _manual()
        del goal["manual_as_of"]
        assert shared.goal_nudge.is_stale(goal, TODAY) is False

    def test_none_manual_as_of_is_not_stale(self, shared):
        assert shared.goal_nudge.is_stale(_manual(manual_as_of=None), TODAY) is False

    def test_unparseable_manual_as_of_is_not_stale(self, shared):
        assert shared.goal_nudge.is_stale(_manual(manual_as_of="not-a-date"), TODAY) is False


# --- stale trigger inside notify_behind_goals --------------------------------

class TestStaleNudge:
    def test_stale_manual_fires_one_push_with_copy(self, shared, monkeypatch):
        sent, rec, notify, *_ = _run(shared, monkeypatch, {"m1": _manual()})
        assert sent == 1
        assert rec.calls[0]["body"] == "Your Car savings balance is 71 days old — tap to update."
        assert "GOAL#m1#stale" in notify.fired_markers(CYCLE["last_pay_date"], CYCLE["length"])

    def test_synced_goal_never_fires_stale(self, shared, monkeypatch):
        # Far deadline so behind can't fire either -> a synced goal produces no push at all.
        sent, rec, *_ = _run(shared, monkeypatch, {"g1": _grow(target_date="2026-12-01")},
                             balances={"up-spending": Decimal(4000)})
        assert sent == 0
        assert rec.calls == []

    def test_recent_manual_does_not_fire_stale(self, shared, monkeypatch):
        sent, *_ = _run(shared, monkeypatch, {"m1": _manual(manual_as_of="2026-07-01")})
        assert sent == 0

    def test_stale_fires_even_when_behind_marker_already_set(self, shared, monkeypatch):
        # The behind marker fired earlier this cycle; stale is independent and must STILL fire.
        # (Fail-on-revert for the per-trigger marker split — a single shared guard would swallow
        # this.) target_date near so the goal is also behind, its behind marker pre-seeded.
        notify = FakeNotifyRepo()
        notify.mark_fired(CYCLE["last_pay_date"], CYCLE["length"], "GOAL#m1")
        goal = _manual(target_date="2026-07-18")  # behind AND stale
        sent, rec, notify, *_ = _run(shared, monkeypatch, {"m1": goal}, notify=notify)
        assert sent == 1
        assert rec.calls[0]["title"] == shared.goal_nudge._STALE_TITLE
        markers = notify.fired_markers(CYCLE["last_pay_date"], CYCLE["length"])
        assert "GOAL#m1#stale" in markers

    def test_behind_and_stale_fire_two_independent_pushes(self, shared, monkeypatch):
        goal = _manual(target_date="2026-07-18")  # short + imminent (behind) AND 71 days old (stale)
        sent, rec, notify, *_ = _run(shared, monkeypatch, {"m1": goal})
        assert sent == 2
        titles = {call["title"] for call in rec.calls}
        assert titles == {shared.goal_nudge._STALE_TITLE, shared.goal_nudge._TITLE}
        markers = notify.fired_markers(CYCLE["last_pay_date"], CYCLE["length"])
        assert {"GOAL#m1", "GOAL#m1#stale"} <= markers

    def test_stale_dedupe_same_cycle(self, shared, monkeypatch):
        notify = FakeNotifyRepo()
        notify.mark_fired(CYCLE["last_pay_date"], CYCLE["length"], "GOAL#m1#stale")
        sent, rec, *_ = _run(shared, monkeypatch, {"m1": _manual()}, notify=notify)
        assert sent == 0
        assert rec.calls == []

    def test_stale_mark_on_landing_outage_leaves_unmarked(self, shared, monkeypatch):
        notify = FakeNotifyRepo()
        sent, rec, notify, *_ = _run(shared, monkeypatch, {"m1": _manual()}, notify=notify, send_ok=0)
        assert sent == 0
        assert notify.fired_markers(CYCLE["last_pay_date"], CYCLE["length"]) == set()

    def test_behind_only_synced_goal_writes_no_stale_marker(self, shared, monkeypatch):
        # Regression: the loop restructure must not alter the pure behind path.
        sent, rec, notify, *_ = _run(shared, monkeypatch, {"g1": _grow()},
                                     balances={"up-spending": Decimal(4000)})
        assert sent == 1
        markers = notify.fired_markers(CYCLE["last_pay_date"], CYCLE["length"])
        assert markers == {"GOAL#g1"}  # exactly the behind marker, no stale marker
