"""WHIT-236 — behind-pace nudge detection + send/dedupe (shared/goal_nudge.py).

Fakes for every repo (no DynamoDB); ``send_push`` is stubbed to capture pushes, mirroring
tests/lambda/test_budget_alerts.py. Locks: the "behind" definition (option A — imminent
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

    def test_stale_push_carries_goal_deeplink_data(self, shared, monkeypatch):
        # WHIT-322 GAP — the STALE nudge is a second, conceptually-distinct send site that also
        # flows through send_and_mark, so it must ALSO carry data={"type": "goal"}. The
        # implementer only locked the behind-pace push; a stale-only data regression would slip
        # past that. _manual() defaults are stale-but-not-behind, so this is the pure stale path.
        _, rec, *_ = _run(shared, monkeypatch, {"m1": _manual()})
        assert rec.calls[0]["title"] == shared.goal_nudge._STALE_TITLE  # proves it's the stale push
        assert rec.calls[0]["data"] == {"type": "goal"}

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


# --- folded from test_goal_nudge_edges.py (WHIT-463) ---


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


# --- folded from test_goal_nudge_gaps.py (WHIT-463) ---


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
