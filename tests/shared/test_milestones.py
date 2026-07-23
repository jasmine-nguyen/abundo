"""Tests for the payoff-milestone celebration push (shared/milestones.py, WHIT-301).

Covers the pure crossing/equity math, the twin-table drift-pin (client<->server), and
the detector's send/dedup/mark-regardless/degrade behaviour via lightweight fake repos.
"""

from decimal import Decimal

import pytest


# --- fake repos + a send_push recorder --------------------------------------------------

class FakeLoanFactsRepo:
    def __init__(self, facts=None):
        self._facts = facts

    def get_loanfacts(self):
        return self._facts


class FakeDeviceRepo:
    def __init__(self, tokens):
        self._tokens = tokens

    def list_tokens(self):
        return list(self._tokens)


class FakeNotifyRepo:
    def __init__(self, fired=None):
        self.fired = set(fired or set())

    def fired_milestones(self):
        return set(self.fired)

    def mark_milestone_fired(self, sprint):
        assert isinstance(sprint, str), "sprint marker must be a string (String Set)"
        self.fired.add(sprint)


@pytest.fixture
def recorder(shared, monkeypatch):
    """Replace shared.milestones.send_push with a recorder returning {ok:1} by default."""
    calls = []

    def fake(title, body, tokens, **kw):
        calls.append((title, body, tokens))
        return {"sent": len(tokens), "ok": len(tokens), "pruned": []}

    monkeypatch.setattr(shared.milestones, "send_push", fake)
    return calls


# The user's real loan facts shape (LoanFactsRepository returns floats or None).
FACTS = {"original": 600000.0, "homeValue": 770000.0, "lvr": 0.8,
         "ratePct": 5.95, "baseRepay": 3570.0, "extra": 12000.0, "payoffGoalDate": None}


# --- twin-table drift-pin (client <-> server) -------------------------------------------

def test_milestones_match_the_client_plan(shared):
    rows = [(m.sprint, m.label, m.target_balance) for m in shared.milestones.MILESTONES]
    assert rows == [
        (0, "Kickoff", 544000),
        (1, "Quarter way", 420000),
        (2, "Halfway", 295000),
        (3, "Three-quarters", 170000),
        (4, "Target", 55000),
    ]


def test_strictly_paid_down_invariant_fires_on_a_bad_table(shared):
    Milestone = shared.milestones.Milestone
    bad = [Milestone(0, "a", 100000), Milestone(1, "b", 200000)]  # balance goes UP
    with pytest.raises(ValueError):
        shared.milestones._assert_strictly_paid_down(bad)


# --- usable_equity ----------------------------------------------------------------------

def test_usable_equity_matches_the_client_formula(shared):
    # 770000 * 0.8 - 295000 = 321000
    assert shared.milestones.usable_equity(770000.0, 295000.0, 0.8) == 321000


def test_usable_equity_clamps_at_zero(shared):
    assert shared.milestones.usable_equity(500000.0, 500000.0, 0.8) == 0


# --- crossed_milestones (pure) ----------------------------------------------------------

def test_no_crossing_when_balance_holds_above_a_target(shared):
    assert shared.milestones.crossed_milestones(Decimal("600000"), Decimal("560000")) == []


def test_first_poll_none_crosses_nothing(shared):
    # old is None (first-ever poll / seed guard) → never fire, even far below a target.
    assert shared.milestones.crossed_milestones(None, Decimal("100000")) == []


def test_rising_balance_crosses_nothing(shared):
    assert shared.milestones.crossed_milestones(Decimal("400000"), Decimal("410000")) == []


def test_exact_boundary_landing_counts_as_crossed(shared):
    # new == target fires; the NEXT poll starting ON the boundary must not (old > target false).
    crossed = shared.milestones.crossed_milestones(Decimal("545000"), Decimal("544000"))
    assert [m.sprint for m in crossed] == [0]
    assert shared.milestones.crossed_milestones(Decimal("544000"), Decimal("543000")) == []


def test_lump_sum_jump_returns_furthest_first(shared):
    # 600k -> 290k crosses Kickoff(544k), Quarter(420k), Halfway(295k); furthest (lowest) first.
    crossed = shared.milestones.crossed_milestones(Decimal("600000"), Decimal("290000"))
    assert [m.target_balance for m in crossed] == [295000, 420000, 544000]


# --- notify_milestone_crossing ----------------------------------------------------------

def _notify(shared, *, old, new, facts=FACTS, tokens=("tok",), fired=None):
    return shared.milestones.notify_milestone_crossing(
        Decimal(old) if old is not None else None,
        Decimal(new),
        loanfacts_repo=FakeLoanFactsRepo(facts),
        device_repo=FakeDeviceRepo(tokens),
        notify_repo=FakeNotifyRepo(fired),
    )


def test_single_crossing_sends_one_push_with_both_numbers(shared, recorder):
    notify = FakeNotifyRepo()
    sent = shared.milestones.notify_milestone_crossing(
        Decimal("545000"), Decimal("544000"),
        loanfacts_repo=FakeLoanFactsRepo(FACTS), device_repo=FakeDeviceRepo(["tok"]), notify_repo=notify)
    assert sent == 1
    assert len(recorder) == 1
    title, body, tokens = recorder[0]
    assert title == "\U0001f389 Milestone reached — Kickoff!"
    # paid = 600000 - 544000 = 56,000 ; equity = 770000*0.8 - 544000 = 72,000
    assert "$56,000 down on your mortgage" in body
    assert "$72,000 in equity unlocked" in body
    assert "Keep building!" in body
    assert notify.fired == {"0"}


def test_crossing_push_carries_milestone_deeplink_data(shared, monkeypatch):
    # WHIT-322: the push carries data={"type": "milestone"} so a tap opens the mortgage screen.
    captured = []
    monkeypatch.setattr(shared.milestones, "send_push",
                        lambda title, body, tokens, **kw: captured.append(kw.get("data")) or
                        {"sent": len(tokens), "ok": len(tokens), "pruned": []})
    shared.milestones.notify_milestone_crossing(
        Decimal("545000"), Decimal("544000"),
        loanfacts_repo=FakeLoanFactsRepo(FACTS), device_repo=FakeDeviceRepo(["tok"]),
        notify_repo=FakeNotifyRepo())
    assert captured == [{"type": "milestone"}]


def test_lump_sum_sends_furthest_and_marks_all(shared, recorder):
    notify = FakeNotifyRepo()
    sent = shared.milestones.notify_milestone_crossing(
        Decimal("600000"), Decimal("290000"),
        loanfacts_repo=FakeLoanFactsRepo(FACTS), device_repo=FakeDeviceRepo(["tok"]), notify_repo=notify)
    assert sent == 1
    assert len(recorder) == 1
    assert recorder[0][0] == "\U0001f389 Milestone reached — Halfway!"  # furthest crossed (295k)
    assert notify.fired == {"0", "1", "2"}  # all three crossed are marked


def test_lump_sum_push_carries_milestone_deeplink_data(shared, monkeypatch):
    # WHIT-322 GAP — a lump-sum jump past SEVERAL milestones still sends exactly one push (the
    # furthest), and it must ALSO carry data={"type": "milestone"}. The implementer only locked
    # the single-crossing send; this guards the lump-sum branch of the same call site.
    captured = []
    monkeypatch.setattr(shared.milestones, "send_push",
                        lambda title, body, tokens, **kw: captured.append(kw.get("data")) or
                        {"sent": len(tokens), "ok": len(tokens), "pruned": []})
    notify = FakeNotifyRepo()
    sent = shared.milestones.notify_milestone_crossing(
        Decimal("600000"), Decimal("290000"),
        loanfacts_repo=FakeLoanFactsRepo(FACTS), device_repo=FakeDeviceRepo(["tok"]),
        notify_repo=notify)
    assert sent == 1
    assert captured == [{"type": "milestone"}]  # one push, carrying the deep-link tag
    assert notify.fired == {"0", "1", "2"}       # all crossed still marked


def test_already_fired_milestone_does_not_resend(shared, recorder):
    sent = _notify(shared, old="545000", new="544000", fired={"0"})
    assert sent == 0
    assert recorder == []


def test_no_device_short_circuits(shared, recorder):
    notify = FakeNotifyRepo()
    sent = shared.milestones.notify_milestone_crossing(
        Decimal("545000"), Decimal("544000"),
        loanfacts_repo=FakeLoanFactsRepo(FACTS), device_repo=FakeDeviceRepo([]), notify_repo=notify)
    assert sent == 0
    assert recorder == []
    assert notify.fired == set()  # nothing marked when there was no one to send to


def test_expo_not_ok_still_marks_no_permanent_loss(shared, monkeypatch):
    # The blocker fix: mark REGARDLESS of send outcome, so a failed send can't leave the
    # milestone forever-unmarked (the crossing is never re-detected to retry).
    monkeypatch.setattr(shared.milestones, "send_push",
                        lambda *a, **k: {"sent": 1, "ok": 0, "pruned": []})
    notify = FakeNotifyRepo()
    sent = shared.milestones.notify_milestone_crossing(
        Decimal("545000"), Decimal("544000"),
        loanfacts_repo=FakeLoanFactsRepo(FACTS), device_repo=FakeDeviceRepo(["tok"]), notify_repo=notify)
    assert sent == 1
    assert notify.fired == {"0"}  # marked even though Expo accepted nothing


def test_loan_facts_unset_sends_bare_body_no_crash(shared, recorder):
    sent = _notify(shared, old="545000", new="544000", facts=None)
    assert sent == 1
    title, body, _ = recorder[0]
    assert body == "Another mortgage milestone in the bag. Keep building! \U0001f4aa"
    assert "$" not in body  # no dollar figures when facts are unset


def test_first_poll_none_sends_nothing(shared, recorder):
    assert _notify(shared, old=None, new="100000") == 0
    assert recorder == []
