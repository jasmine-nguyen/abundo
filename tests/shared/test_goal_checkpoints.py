"""Goal-checkpoint crossing celebration (WHIT-479 slice 4a).

crossed_checkpoints (direction-aware, seed guard, baseline tolerance), _checkpoint_marker
(cent-quantized, re-arm on re-point), normalise_goal_balance (twin of the client's normaliseBalance),
and notify_goal_checkpoint_crossing (once-ever dedup, furthest-along push, mark-regardless-of-send).
"""

from decimal import Decimal

import pytest


@pytest.fixture
def gc(shared):
    """The goal_checkpoints module, imported with shared/ on the path (its `from push import ...`
    resolves the shared push module)."""
    return shared.goal_checkpoints


def _cp(cp_id, label, amount):
    return {"id": cp_id, "label": label, "amount": Decimal(str(amount))}


def _goal(direction="grow", checkpoints=None, name="Holiday"):
    return {"direction": direction, "name": name, "checkpoints": checkpoints or []}


# --- normalise_goal_balance: the exact twin of src/context.tsx normaliseBalance ---------------


def test_normalise_grow_clamps_an_overdrawn_account_to_zero(gc):
    assert gc.normalise_goal_balance(Decimal("-50"), "grow", True) == Decimal("0")
    assert gc.normalise_goal_balance(Decimal("4000"), "grow", True) == Decimal("4000")


def test_normalise_synced_paydown_flips_a_negative_loan_to_positive_owed(gc):
    # A synced loan account is stored NEGATIVE; owed is its magnitude.
    assert gc.normalise_goal_balance(Decimal("-3000"), "paydown", True) == Decimal("3000")


def test_normalise_manual_paydown_keeps_the_entered_positive_owed(gc):
    assert gc.normalise_goal_balance(Decimal("8000"), "paydown", False) == Decimal("8000")


# --- crossed_checkpoints: direction-aware, inclusive new edge, seed guard, baseline ------------


def test_grow_crosses_upward_inclusive_at_the_amount(gc):
    goal = _goal("grow", [_cp("a", "First", 2000), _cp("b", "Halfway", 4000), _cp("c", "Nearly", 6000)])
    # old 1500 -> new 4000: crosses 2000 and 4000 (4000 inclusive on the new edge), not 6000.
    crossed = gc.crossed_checkpoints(goal, Decimal("1500"), Decimal("4000"))
    assert [c["label"] for c in crossed] == ["First", "Halfway"]


def test_grow_does_not_cross_a_rung_one_dollar_above_new(gc):
    goal = _goal("grow", [_cp("a", "Rung", 4000)])
    assert gc.crossed_checkpoints(goal, Decimal("1000"), Decimal("3999")) == []


def test_paydown_crosses_downward_inclusive_at_the_amount(gc):
    goal = _goal("paydown", [_cp("a", "Under 6k", 6000), _cp("b", "Under 3k", 3000), _cp("c", "Clear", 500)])
    # owed 7000 -> 3000: crosses 6000 and 3000 (3000 inclusive), not 500.
    crossed = gc.crossed_checkpoints(goal, Decimal("7000"), Decimal("3000"))
    assert [c["label"] for c in crossed] == ["Under 6k", "Under 3k"]


def test_a_grow_balance_falling_never_crosses(gc):
    goal = _goal("grow", [_cp("a", "Rung", 3000)])
    assert gc.crossed_checkpoints(goal, Decimal("5000"), Decimal("2000")) == []


def test_a_paydown_balance_rising_never_crosses(gc):
    goal = _goal("paydown", [_cp("a", "Rung", 3000)])
    assert gc.crossed_checkpoints(goal, Decimal("2000"), Decimal("5000")) == []


def test_seed_guard_first_ever_balance_crosses_nothing(gc):
    goal = _goal("grow", [_cp("a", "Rung", 1000)])
    assert gc.crossed_checkpoints(goal, None, Decimal("9000")) == []


def test_baseline_tolerance_a_rung_already_passed_at_the_start_never_crosses(gc):
    # old already past the rung (4000 >= 1000) -> no upward crossing of 1000.
    goal = _goal("grow", [_cp("a", "Behind us", 1000), _cp("b", "Ahead", 5000)])
    crossed = gc.crossed_checkpoints(goal, Decimal("4000"), Decimal("6000"))
    assert [c["label"] for c in crossed] == ["Ahead"]


# --- _checkpoint_marker: id + cent-quantized amount -------------------------------------------


def test_marker_is_stable_across_decimal_formatting(gc):
    a = gc._checkpoint_marker("g1", _cp("cp1", "X", "5000"))
    b = gc._checkpoint_marker("g1", _cp("cp1", "X", "5000.0"))
    c = gc._checkpoint_marker("g1", _cp("cp1", "X", "5000.00"))
    assert a == b == c == "g:g1:cp:cp1:bal:5000.00"


def test_marker_rearms_when_the_amount_is_re_pointed_but_not_on_rename(gc):
    base = gc._checkpoint_marker("g1", _cp("cp1", "Old name", "5000"))
    renamed = gc._checkpoint_marker("g1", _cp("cp1", "New name", "5000"))
    repointed = gc._checkpoint_marker("g1", _cp("cp1", "Old name", "5001"))
    assert renamed == base          # rename/reorder keep the id+amount -> same marker
    assert repointed != base        # a new amount -> a fresh marker (re-arms the celebration)


# --- notify_goal_checkpoint_crossing (with fakes) --------------------------------------------


class _FakeNotify:
    def __init__(self, fired=None):
        self._fired = set(fired or [])
        self.marked = []

    def fired_goal_checkpoints(self, scope=None):
        return set(self._fired)

    def mark_goal_checkpoint_fired(self, key, scope=None):
        self.marked.append(key)
        self._fired.add(key)


class _FakeDevice:
    def __init__(self, tokens=("ExpoTok",)):
        self._tokens = list(tokens)

    def list_tokens(self):
        return self._tokens


def _notify(gc, monkeypatch, goal, old, new, *, synced=True, fired=None, tokens=("ExpoTok",)):
    sent = []
    monkeypatch.setattr(gc, "send_push", lambda title, body, toks, data=None: sent.append((title, body, toks, data)) or {"ok": len(toks)})
    notify = _FakeNotify(fired)
    device = _FakeDevice(tokens)
    n = gc.notify_goal_checkpoint_crossing(old, new, goal=goal, goal_id="g1", synced=synced, device_repo=device, notify_repo=notify)
    return n, sent, notify


def test_notify_sends_one_push_and_marks_the_crossed_rung(gc, monkeypatch):
    goal = _goal("grow", [_cp("cp1", "Halfway", 4000)])
    n, sent, notify = _notify(gc, monkeypatch, goal, Decimal("1000"), Decimal("5000"))
    assert n == 1
    assert len(sent) == 1
    title, body, _toks, data = sent[0]
    assert "Halfway" in title
    assert data == {"type": "goalcheckpoint", "goalId": "g1"}
    assert notify.marked == ["g:g1:cp:cp1:bal:4000.00"]


def test_notify_multi_rung_jump_sends_one_push_for_the_furthest_marks_all(gc, monkeypatch):
    goal = _goal("grow", [_cp("cp1", "A", 2000), _cp("cp2", "B", 4000), _cp("cp3", "C", 6000)])
    n, sent, notify = _notify(gc, monkeypatch, goal, Decimal("1000"), Decimal("7000"))
    assert n == 1
    assert "C" in sent[0][0]  # the furthest-along rung names the push
    assert set(notify.marked) == {
        "g:g1:cp:cp1:bal:2000.00", "g:g1:cp:cp2:bal:4000.00", "g:g1:cp:cp3:bal:6000.00",
    }


def test_notify_already_fired_rung_does_not_re_send(gc, monkeypatch):
    goal = _goal("grow", [_cp("cp1", "Halfway", 4000)])
    n, sent, _ = _notify(gc, monkeypatch, goal, Decimal("1000"), Decimal("5000"), fired=["g:g1:cp:cp1:bal:4000.00"])
    assert n == 0
    assert sent == []


def test_notify_no_crossing_does_no_io(gc, monkeypatch):
    goal = _goal("grow", [_cp("cp1", "Halfway", 4000)])
    n, sent, notify = _notify(gc, monkeypatch, goal, Decimal("5000"), Decimal("6000"))  # both already past
    assert n == 0
    assert sent == [] and notify.marked == []


def test_notify_no_devices_does_not_send_and_does_not_mark(gc, monkeypatch):
    goal = _goal("grow", [_cp("cp1", "Halfway", 4000)])
    n, sent, notify = _notify(gc, monkeypatch, goal, Decimal("1000"), Decimal("5000"), tokens=())
    assert n == 0
    assert sent == []
    assert notify.marked == []  # no push, nothing marked → only re-fires on a genuinely NEW crossing


def test_notify_synced_paydown_uses_owed_magnitude(gc, monkeypatch):
    # synced loan: old -5000 (owed 5000) -> new -3000 (owed 3000); a rung at 4000 owed is crossed.
    goal = _goal("paydown", [_cp("cp1", "Under 4k", 4000)])
    n, sent, notify = _notify(gc, monkeypatch, goal, Decimal("-5000"), Decimal("-3000"), synced=True)
    assert n == 1
    assert notify.marked == ["g:g1:cp:cp1:bal:4000.00"]
