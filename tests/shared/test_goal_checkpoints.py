"""Goal-checkpoint crossing celebration (WHIT-479 slice 4a).

crossed_checkpoints (direction-aware, seed guard, baseline tolerance), _checkpoint_marker
(cent-quantized, re-arm on re-point), normalise_goal_balance (twin of the client's normaliseBalance),
notify_goal_checkpoint_crossing (once-ever dedup, furthest-along push, mark-regardless-of-send)
and check_goal_checkpoints (the per-goal loop the daily poll and pull-to-refresh share).
"""

from decimal import Decimal

import pytest

from _milestone_fakes import FakeGoalsRepo, checkpoints_marked, goal_checkpoint_repo


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


@pytest.mark.parametrize("balance, direction, synced, expected", [
    ("-50", "grow", True, "0"),            # an overdrawn account clamps to zero
    ("4000", "grow", True, "4000"),
    ("-3000", "paydown", True, "3000"),    # a synced loan is stored NEGATIVE; owed is its magnitude
    ("8000", "paydown", False, "8000"),    # a manual paydown keeps the entered positive owed
])
def test_normalise_goal_balance_matches_the_client_twin(gc, balance, direction, synced, expected):
    assert gc.normalise_goal_balance(Decimal(balance), direction, synced) == Decimal(expected)


# --- crossed_checkpoints: direction-aware, inclusive new edge, seed guard, baseline ------------


@pytest.mark.parametrize("goal, old, new, expected", [
    # 1500 -> 4000 crosses 2000 and 4000 (inclusive on the new edge), not 6000.
    pytest.param(_goal("grow", [_cp("a", "First", 2000), _cp("b", "Halfway", 4000), _cp("c", "Nearly", 6000)]),
                 "1500", "4000", ["First", "Halfway"], id="grow-inclusive"),
    # owed 7000 -> 3000 crosses 6000 and 3000 (inclusive), not 500.
    pytest.param(_goal("paydown", [_cp("a", "Under 6k", 6000), _cp("b", "Under 3k", 3000), _cp("c", "Clear", 500)]),
                 "7000", "3000", ["Under 6k", "Under 3k"], id="paydown-inclusive"),
    pytest.param(_goal("grow", [_cp("a", "Rung", 3000)]), "5000", "2000", [], id="grow-falling"),
    pytest.param(_goal("paydown", [_cp("a", "Rung", 3000)]), "2000", "5000", [], id="paydown-rising"),
    pytest.param(_goal("grow", [_cp("a", "Rung", 1000)]), None, "9000", [], id="seed-none"),
    # a rung already passed at the start never crosses
    pytest.param(_goal("grow", [_cp("a", "Behind us", 1000), _cp("b", "Ahead", 5000)]),
                 "4000", "6000", ["Ahead"], id="already-passed-start"),
    # a rung the balance sits EXACTLY on at the start is already passed, both directions
    pytest.param(_goal("grow", [_cp("a", "On it", 4000), _cp("b", "Ahead", 6000)]),
                 "4000", "6000", ["Ahead"], id="grow-start-on-rung"),
    pytest.param(_goal("paydown", [_cp("a", "On it", 3000), _cp("b", "Lower", 1000)]),
                 "3000", "1000", ["Lower"], id="paydown-start-on-rung"),
])
def test_crossed_checkpoints_is_direction_aware(gc, goal, old, new, expected):
    old = Decimal(old) if old is not None else None
    crossed = gc.crossed_checkpoints(goal, old, Decimal(new))
    assert [c["label"] for c in crossed] == expected


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


class _FakeDevice:
    def __init__(self, tokens=("ExpoTok",)):
        self._tokens = list(tokens)

    def list_tokens(self):
        return self._tokens


def _spy_send(gc, monkeypatch):
    sent = []
    monkeypatch.setattr(
        gc, "send_push",
        lambda title, body, toks, data=None: sent.append((title, body, toks, data)) or {"ok": len(toks)},
    )
    return sent


def _notify(gc, monkeypatch, goal, old, new, *, synced=True, fired=None, tokens=("ExpoTok",)):
    sent = _spy_send(gc, monkeypatch)
    notify = goal_checkpoint_repo(fired or ())
    n = gc.notify_goal_checkpoint_crossing(old, new, goal=goal, goal_id="g1", synced=synced,
                                           device_repo=_FakeDevice(tokens), notify_repo=notify)
    return n, sent, notify


def test_notify_sends_one_push_and_marks_the_crossed_rung(gc, monkeypatch):
    goal = _goal("grow", [_cp("cp1", "Halfway", 4000)])
    n, sent, notify = _notify(gc, monkeypatch, goal, Decimal("1000"), Decimal("5000"))
    assert n == 1
    assert len(sent) == 1
    title, body, _toks, data = sent[0]
    assert "Halfway" in title
    assert data == {"type": "goalcheckpoint", "goalId": "g1"}
    assert checkpoints_marked(notify) == ["g:g1:cp:cp1:bal:4000.00"]


def test_notify_multi_rung_jump_sends_one_push_for_the_furthest_marks_all(gc, monkeypatch):
    goal = _goal("grow", [_cp("cp1", "A", 2000), _cp("cp2", "B", 4000), _cp("cp3", "C", 6000)])
    n, sent, notify = _notify(gc, monkeypatch, goal, Decimal("1000"), Decimal("7000"))
    assert n == 1
    assert "C" in sent[0][0]  # the furthest-along rung names the push
    assert set(checkpoints_marked(notify)) == {
        "g:g1:cp:cp1:bal:2000.00", "g:g1:cp:cp2:bal:4000.00", "g:g1:cp:cp3:bal:6000.00",
    }


def test_notify_no_devices_does_not_send_and_does_not_mark(gc, monkeypatch):
    goal = _goal("grow", [_cp("cp1", "Halfway", 4000)])
    n, sent, notify = _notify(gc, monkeypatch, goal, Decimal("1000"), Decimal("5000"), tokens=())
    assert n == 0
    assert sent == []
    assert checkpoints_marked(notify) == []  # no push, nothing marked → only re-fires on a genuinely NEW crossing


def test_notify_synced_paydown_uses_owed_magnitude(gc, monkeypatch):
    # synced loan: old -5000 (owed 5000) -> new -3000 (owed 3000); a rung at 4000 owed is crossed.
    goal = _goal("paydown", [_cp("cp1", "Under 4k", 4000)])
    n, sent, notify = _notify(gc, monkeypatch, goal, Decimal("-5000"), Decimal("-3000"), synced=True)
    assert n == 1
    assert checkpoints_marked(notify) == ["g:g1:cp:cp1:bal:4000.00"]


def test_notify_none_ladder_does_no_io(gc, monkeypatch):
    goal = {"direction": "grow", "checkpoints": None}
    n, sent, notify = _notify(gc, monkeypatch, goal, Decimal("0"), Decimal("9999"))
    assert n == 0 and sent == [] and checkpoints_marked(notify) == []


def test_notify_multi_jump_skips_already_fired_rung_marks_only_fresh(gc, monkeypatch):
    # cp2 (4000) already celebrated; a 1000->5000 jump re-crosses it AND freshly crosses cp1.
    goal = _goal("grow", [_cp("cp1", "A", 2000), _cp("cp2", "B", 4000)])
    n, sent, notify = _notify(gc, monkeypatch, goal, Decimal("1000"), Decimal("5000"),
                              fired=["g:g1:cp:cp2:bal:4000.00"])
    assert n == 1
    assert "A" in sent[0][0]                       # furthest-along FRESH rung, not the fired one
    assert checkpoints_marked(notify) == ["g:g1:cp:cp1:bal:2000.00"]  # only the fresh rung is marked


def test_notify_recross_of_same_rung_fires_once_ever(gc, monkeypatch):
    # The balance falls below a fired rung then rises through it again -> NO second push.
    sent = _spy_send(gc, monkeypatch)
    notify = goal_checkpoint_repo()
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
    assert checkpoints_marked(notify) == ["g:g1:cp:cp1:bal:4000.00"]  # marked exactly once


# --- check_goal_checkpoints: the per-goal loop the daily poll and pull-to-refresh share -------
# The crossing maths is stubbed: these prove which goals are checked, with which old/new, and
# that one goal's failure keeps going.

def _synced(account_id, direction="grow"):
    return {"direction": direction, "name": "G", "account_id": account_id,
            "checkpoints": [_cp("c", "H", 95000)]}


def _delta(account_id, old, new):
    return {"account_id": account_id, "old": old, "new": new}


@pytest.mark.parametrize(
    ("goals", "deltas", "expected"),
    [
        ({}, [_delta("up-spending", Decimal("1"), Decimal("2"))], []),
        (
            {"g1": _synced("up-spending"), "g2": _synced("anz-rewards-black-visa", "paydown")},
            [_delta("up-spending", Decimal("90000"), Decimal("96270.59")),
             _delta("anz-rewards-black-visa", Decimal("-6000"), Decimal("-4000"))],
            [("g1", Decimal("90000"), Decimal("96270.59"), True),
             ("g2", Decimal("-6000"), Decimal("-4000"), True)],
        ),
        (
            {"manual": {"direction": "grow", "account_id": None, "manual_balance": Decimal("5000"),
                        "checkpoints": []},
             "unfetched": _synced("anz-rewards-black-visa")},
            [_delta("up-spending", Decimal("1"), Decimal("2"))],
            [],
        ),
        (
            {"g1": _synced("up-spending")},
            [_delta("up-spending", None, Decimal("96000"))],
            [("g1", None, Decimal("96000"), True)],
        ),
    ],
    ids=["no-goals", "each-goal-gets-its-own-delta", "manual-and-unfetched-skipped", "first-reading-old-none"],
)
def test_check_goal_checkpoints_checks_each_synced_goal_on_its_accounts_delta(
    gc, monkeypatch, goals, deltas, expected
):
    seen = []
    monkeypatch.setattr(gc, "notify_goal_checkpoint_crossing",
                        lambda old, new, **kw: seen.append((kw["goal_id"], old, new, kw["synced"])) or 1)

    gc.check_goal_checkpoints(deltas, goals_repo=FakeGoalsRepo(goals),
                              device_repo=object(), notify_repo=object())

    assert seen == expected


def test_check_goal_checkpoints_isolates_a_single_goal_failure(gc, monkeypatch):
    goals = {"boom": _synced("up-spending"), "ok": _synced("anz-rewards-black-visa", "paydown")}
    fired = []

    def flaky(old, new, **kw):
        if kw["goal_id"] == "boom":
            raise RuntimeError("expo down for this goal")
        fired.append(kw["goal_id"])
        return 1

    monkeypatch.setattr(gc, "notify_goal_checkpoint_crossing", flaky)

    gc.check_goal_checkpoints(
        [_delta("up-spending", Decimal("90000"), Decimal("96000")),
         _delta("anz-rewards-black-visa", Decimal("-6000"), Decimal("-4000"))],
        goals_repo=FakeGoalsRepo(goals), device_repo=object(), notify_repo=object(),
    )

    assert fired == ["ok"]
