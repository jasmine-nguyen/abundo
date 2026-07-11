"""WHIT-236 — behind-pace nudge detection + send/dedupe (shared/goal_nudge.py).

Fakes for every repo (no DynamoDB); ``send_push`` is stubbed to capture pushes, mirroring
tests/lambda/test_repayment_alerts.py. Locks: the "behind" definition (option A — imminent
deadline, still short, not lapsed), the per-(goal, cycle) dedupe + re-arm, mark-on-landing,
the short-circuits, the synced-not-polled skip, and the SIGNED-balance path for a paydown
goal (a positive/abs balance would read as met and never fire — the critic's MAJOR fix).
Fortnightly cycle, paydays land …Jul4, Jul18, Aug1, Aug15; "today" = Sat 11 Jul 2026.
"""

from decimal import Decimal

from _goal_nudge_fakes import CYCLE, TODAY, FakeNotifyRepo, _grow, _run


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
