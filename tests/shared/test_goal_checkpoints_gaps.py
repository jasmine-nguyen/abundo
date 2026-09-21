"""WHIT-479 slice 4a — adversarial gap tests for goal-checkpoint crossings.

Complements tests/shared/test_goal_checkpoints.py (happy path + acceptance). Covers the
boundaries/regressions that file misses: None/absent ladder, exact start-equality on BOTH
directions, manual paydown owed, cap-sized amounts, mixed fired/fresh in one jump, and the two
that PROVE the no-TTL once-ever contract end-to-end — re-cross dedup and re-point re-arm.
"""

from decimal import Decimal

import pytest


@pytest.fixture
def gc(shared):
    return shared.goal_checkpoints


def _cp(cp_id, label, amount):
    return {"id": cp_id, "label": label, "amount": Decimal(str(amount))}


def _goal(direction="grow", checkpoints=None, name="Holiday"):
    return {"direction": direction, "name": name, "checkpoints": checkpoints or []}


# --- persistent fakes so a SEQUENCE of crossings shares one marker set / token list ----------

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
        self.tokens = list(tokens)

    def list_tokens(self):
        return list(self.tokens)


def _spy_send(gc, monkeypatch):
    sent = []
    monkeypatch.setattr(
        gc, "send_push",
        lambda title, body, toks, data=None: sent.append((title, body, toks, data)) or {"ok": len(toks)},
    )
    return sent


# --- checkpoints=None / absent ladder: no crash, no crossing ---------------------------------
# [A20] crossed_checkpoints tolerates a goal whose `checkpoints` is None or absent.

def test_crossed_checkpoints_none_ladder_returns_empty(gc):
    assert gc.crossed_checkpoints({"direction": "grow", "checkpoints": None},
                                  Decimal("0"), Decimal("9999")) == []


def test_crossed_checkpoints_absent_ladder_key_returns_empty(gc):
    assert gc.crossed_checkpoints({"direction": "grow"}, Decimal("0"), Decimal("9999")) == []


def test_notify_none_ladder_does_no_io(gc, monkeypatch):
    sent = _spy_send(gc, monkeypatch)
    notify = _FakeNotify()
    n = gc.notify_goal_checkpoint_crossing(
        Decimal("0"), Decimal("9999"),
        goal={"direction": "grow", "checkpoints": None}, goal_id="g1", synced=True,
        device_repo=_FakeDevice(), notify_repo=notify,
    )
    assert n == 0 and sent == [] and notify.marked == []


def test_notify_empty_ladder_does_no_io(gc, monkeypatch):
    sent = _spy_send(gc, monkeypatch)
    notify = _FakeNotify()
    n = gc.notify_goal_checkpoint_crossing(
        Decimal("0"), Decimal("9999"),
        goal=_goal("grow", []), goal_id="g1", synced=True,
        device_repo=_FakeDevice(), notify_repo=notify,
    )
    assert n == 0 and sent == [] and notify.marked == []


# --- exact START equality (old == amount) never re-crosses, BOTH directions -------------------
# [A21] a rung the balance is sitting EXACTLY on at the start is already-passed, not a crossing.

def test_grow_start_exactly_on_rung_is_not_recrossed(gc):
    goal = _goal("grow", [_cp("a", "On it", 4000), _cp("b", "Ahead", 6000)])
    # old sits exactly on 4000 -> only the higher 6000 crosses.
    crossed = gc.crossed_checkpoints(goal, Decimal("4000"), Decimal("6000"))
    assert [c["label"] for c in crossed] == ["Ahead"]


def test_paydown_start_exactly_on_rung_is_not_recrossed(gc):
    goal = _goal("paydown", [_cp("a", "On it", 3000), _cp("b", "Lower", 1000)])
    # owed sits exactly on 3000 -> only the lower 1000 crosses on the way down.
    crossed = gc.crossed_checkpoints(goal, Decimal("3000"), Decimal("1000"))
    assert [c["label"] for c in crossed] == ["Lower"]


# --- manual paydown: owed entered POSITIVE, decreasing, synced=False --------------------------
# [A22] a manual debt goal celebrates when the ENTERED owed drops through a rung.

def test_notify_manual_paydown_uses_entered_owed(gc, monkeypatch):
    sent = _spy_send(gc, monkeypatch)
    notify = _FakeNotify()
    goal = _goal("paydown", [_cp("cp1", "Under 4k", 4000)])
    n = gc.notify_goal_checkpoint_crossing(
        Decimal("5000"), Decimal("3000"),  # entered owed 5000 -> 3000 (positive, NOT flipped)
        goal=goal, goal_id="g1", synced=False,
        device_repo=_FakeDevice(), notify_repo=notify,
    )
    assert n == 1
    assert "Under 4k" in sent[0][0]
    assert notify.marked == ["g:g1:cp:cp1:bal:4000.00"]


# --- cap-sized amounts stay exact (Decimal, no float) ----------------------------------------
# [A23] a rung at the WHIT-393 amount cap crosses and marks with an exact cent-quantized marker.

def test_notify_cap_sized_amount_crosses_and_marks_exactly(gc, monkeypatch):
    sent = _spy_send(gc, monkeypatch)
    notify = _FakeNotify()
    goal = _goal("grow", [_cp("cp1", "Nearly", "9999999998.55")])
    n = gc.notify_goal_checkpoint_crossing(
        Decimal("1"), Decimal("9999999999.99"),
        goal=goal, goal_id="g1", synced=True,
        device_repo=_FakeDevice(), notify_repo=notify,
    )
    assert n == 1
    assert notify.marked == ["g:g1:cp:cp1:bal:9999999998.55"]


# --- mixed fired + fresh in ONE jump: name the furthest FRESH, mark ONLY fresh ----------------
# [A24] when a multi-rung jump re-crosses an already-fired rung, only the un-fired rungs fire.

def test_notify_multi_jump_skips_already_fired_rung_marks_only_fresh(gc, monkeypatch):
    sent = _spy_send(gc, monkeypatch)
    # cp2 (4000) already celebrated; a 1000->5000 jump re-crosses it AND freshly crosses cp1.
    notify = _FakeNotify(fired=["g:g1:cp:cp2:bal:4000.00"])
    goal = _goal("grow", [_cp("cp1", "A", 2000), _cp("cp2", "B", 4000)])
    n = gc.notify_goal_checkpoint_crossing(
        Decimal("1000"), Decimal("5000"),
        goal=goal, goal_id="g1", synced=True,
        device_repo=_FakeDevice(), notify_repo=notify,
    )
    assert n == 1
    assert "A" in sent[0][0]                       # furthest-along FRESH rung, not the fired one
    assert notify.marked == ["g:g1:cp:cp1:bal:2000.00"]  # only the fresh rung is marked


# --- once-ever: a RE-CROSS of the same rung never fires twice (the whole no-TTL point) --------
# [A25] balance falls below a fired rung then rises through it again -> NO second push.

def test_notify_recross_of_same_rung_fires_once_ever(gc, monkeypatch):
    sent = _spy_send(gc, monkeypatch)
    notify = _FakeNotify()
    device = _FakeDevice()
    goal = _goal("grow", [_cp("cp1", "Halfway", 4000)])

    def cross(old, new):
        return gc.notify_goal_checkpoint_crossing(
            Decimal(str(old)), Decimal(str(new)),
            goal=goal, goal_id="g1", synced=True, device_repo=device, notify_repo=notify,
        )

    assert cross(1000, 5000) == 1           # first cross fires
    assert cross(3000, 5000) == 0           # dropped to 3000 then re-crossed 4000 -> deduped
    assert len(sent) == 1
    assert notify.marked == ["g:g1:cp:cp1:bal:4000.00"]  # marked exactly once


# --- re-point re-arms: same rung id, new amount -> a genuinely fresh celebration ---------------
# [A26] re-pointing a fired checkpoint's amount lets it celebrate again (a new marker).

def test_notify_repoint_of_a_fired_rung_rearms_the_celebration(gc, monkeypatch):
    sent = _spy_send(gc, monkeypatch)
    notify = _FakeNotify()
    device = _FakeDevice()

    goal_v1 = _goal("grow", [_cp("cp1", "Halfway", 4000)])
    assert gc.notify_goal_checkpoint_crossing(
        Decimal("1000"), Decimal("5000"), goal=goal_v1, goal_id="g1", synced=True,
        device_repo=device, notify_repo=notify) == 1

    goal_v2 = _goal("grow", [_cp("cp1", "Halfway", 6000)])  # same id, re-pointed higher
    assert gc.notify_goal_checkpoint_crossing(
        Decimal("5000"), Decimal("7000"), goal=goal_v2, goal_id="g1", synced=True,
        device_repo=device, notify_repo=notify) == 1        # re-arms: fires again

    assert len(sent) == 2
    assert notify.marked == ["g:g1:cp:cp1:bal:4000.00", "g:g1:cp:cp1:bal:6000.00"]


# --- no device at crossing time marks NOTHING, so a genuinely later fresh cross still fires ----
# [A27] a crossing with zero tokens does not consume the marker; a later token+cross fires.

def test_notify_no_tokens_leaves_marker_unset_for_a_later_fresh_cross(gc, monkeypatch):
    sent = _spy_send(gc, monkeypatch)
    notify = _FakeNotify()
    device = _FakeDevice(tokens=())            # no registered device yet
    goal = _goal("grow", [_cp("cp1", "First", 2000), _cp("cp2", "Second", 5000)])

    # Crosses cp1 while no device is registered -> nothing sent, nothing marked.
    assert gc.notify_goal_checkpoint_crossing(
        Decimal("1000"), Decimal("3000"), goal=goal, goal_id="g1", synced=True,
        device_repo=device, notify_repo=notify) == 0
    assert notify.marked == []

    # User registers a device; a later fresh cross of cp2 fires (cp1 stays un-fired/un-marked).
    device.tokens = ["ExpoTok"]
    assert gc.notify_goal_checkpoint_crossing(
        Decimal("3000"), Decimal("6000"), goal=goal, goal_id="g1", synced=True,
        device_repo=device, notify_repo=notify) == 1
    assert "Second" in sent[0][0]
    assert notify.marked == ["g:g1:cp:cp2:bal:5000.00"]
