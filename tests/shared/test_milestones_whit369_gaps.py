"""WHIT-369 GAPS — adversarial edges the implementer's tests don't already lock.

The six happy/edge cases in test_milestones_custom_plan.py + test_repository_notify.py cover:
id-marker format, reorder-no-refire-no-drop, delete-then-readd-same-amount, two-same-amount
distinct markers, legacy-no-id fallback, and repo-level scope isolation. This file adds the
ADVERSARIAL half:

  - the `scope` seam is actually THREADED at the notify level (plan read + fired read + mark
    all see the SAME owner) — not just isolated at the repo level;
  - marking stays "every fresh, regardless of send outcome" once scope is threaded, across a
    MULTI-crossing lump-sum;
  - _plan_marker is byte-stable / collision-free for weird amounts + ids (scientific notation,
    numeric-string id vs a sprint, an id containing the ':' separator, missing/None id);
  - a SAVED user plan that is NOT strictly paid-down (the import assert only guards the built-in
    default) still fires + marks each crossed target.
"""

from decimal import Decimal

import pytest


class FakeLoanFactsRepo:
    def __init__(self, facts=None):
        self._facts = facts

    def get_loanfacts(self):
        return self._facts


class FakeDeviceRepo:
    def __init__(self, tokens=("tok",)):
        self._tokens = tokens

    def list_tokens(self):
        return list(self._tokens)


class RecordingNotifyRepo:
    """Records the `scope` threaded into each fired-state call, so a test can prove the seam
    reaches the read AND the mark — not just that a marker round-trips."""

    def __init__(self, fired=None):
        self.fired = set(fired or set())
        self.fired_scopes = []
        self.mark_scopes = []

    def fired_milestones(self, scope=None):
        self.fired_scopes.append(scope)
        return set(self.fired)

    def mark_milestone_fired(self, key, scope=None):
        assert isinstance(key, str), "marker must be a string (String Set)"
        self.mark_scopes.append(scope)
        self.fired.add(key)


class RecordingMilestoneRepo:
    """Stands in for MilestoneRepository, but records the `scope` resolve_plan passes to the
    plan read. `stored` is the RAW list (targetBalance as Decimal), None when unset."""

    def __init__(self, stored=None):
        self._stored = stored
        self.read_scopes = []

    def get_milestones_raw(self, scope=None):
        self.read_scopes.append(scope)
        return self._stored


FACTS = {"original": 600000.0, "homeValue": 770000.0, "lvr": 0.8,
         "ratePct": 5.95, "baseRepay": 3570.0, "extra": 12000.0, "payoffGoalDate": None}


def _row(label, balance, id="m1", date="2027-01-01"):
    return {"id": id, "label": label, "targetBalance": Decimal(str(balance)), "targetDate": date}


@pytest.fixture
def recorder(shared, monkeypatch):
    calls = []

    def fake(title, body, tokens, **kw):
        calls.append((title, body, tokens))
        return {"sent": len(tokens), "ok": len(tokens), "pruned": []}

    monkeypatch.setattr(shared.milestones, "send_push", fake)
    return calls


# --- the scope seam is threaded end-to-end at the notify level -----------------------------

def test_scope_is_threaded_to_plan_read_fired_state_and_mark(shared, recorder):
    # WHIT-369 — [A-SCOPE-1] the SAME owner drives the plan read, the fired-state read, and the
    # mark. The repo-level test proves isolation; this proves notify_milestone_crossing actually
    # PASSES the caller's scope to all three seams (not None / not a hardcoded owner).
    milestone_repo = RecordingMilestoneRepo(stored=[_row("My House", "480000", id="m1")])
    notify = RecordingNotifyRepo()
    sent = shared.milestones.notify_milestone_crossing(
        Decimal("490000"), Decimal("480000"),
        loanfacts_repo=FakeLoanFactsRepo(FACTS), device_repo=FakeDeviceRepo(),
        notify_repo=notify, milestone_repo=milestone_repo, scope="user-42")
    assert sent == 1
    assert milestone_repo.read_scopes == ["user-42"]     # resolve_plan threaded scope
    assert notify.fired_scopes == ["user-42"]            # dedup read threaded scope
    assert notify.mark_scopes == ["user-42"]             # mark threaded the SAME scope
    assert notify.fired == {"id:m1:bal:480000.00"}


def test_scope_none_default_threads_none_to_every_seam(shared, recorder):
    # WHIT-369 — [A-SCOPE-2] the single-tenant default: omitting scope threads None everywhere,
    # so the repo's own "SHARED" default owns both the plan and the fired-state. Guards against a
    # future edit hardcoding one side to a literal that the other doesn't share.
    milestone_repo = RecordingMilestoneRepo(stored=[_row("My House", "480000", id="m1")])
    notify = RecordingNotifyRepo()
    shared.milestones.notify_milestone_crossing(
        Decimal("490000"), Decimal("480000"),
        loanfacts_repo=FakeLoanFactsRepo(FACTS), device_repo=FakeDeviceRepo(),
        notify_repo=notify, milestone_repo=milestone_repo)  # no scope
    assert milestone_repo.read_scopes == [None]
    assert notify.fired_scopes == [None]
    assert notify.mark_scopes == [None]


def test_dedup_read_is_scoped_so_another_owners_marker_does_not_suppress(shared, recorder):
    # WHIT-369 — [A-SCOPE-3] a marker already fired but read back under the caller's scope still
    # suppresses; the seam must not leak a different owner's fired-state. Here the SAME key is
    # pre-seeded and the caller's scope reads it → no resend.
    notify = RecordingNotifyRepo(fired={"id:m1:bal:480000.00"})
    sent = shared.milestones.notify_milestone_crossing(
        Decimal("490000"), Decimal("480000"),
        loanfacts_repo=FakeLoanFactsRepo(FACTS), device_repo=FakeDeviceRepo(),
        notify_repo=notify, milestone_repo=RecordingMilestoneRepo(stored=[_row("My House", "480000")]),
        scope="user-42")
    assert sent == 0
    assert notify.fired_scopes == ["user-42"]  # the read that suppressed used the caller's scope


# --- mark-regardless-of-send-outcome survives scope threading, across a lump sum ------------

def test_marks_all_fresh_regardless_of_send_outcome_under_a_scope(shared, monkeypatch):
    # WHIT-369 — [A-MARK-1] Expo accepted NOTHING (ok:0) on a lump-sum jump past two custom
    # targets. Every fresh milestone must still be marked, each under the caller's scope — a
    # transient outage must not leave a crossing forever-unmarked (never re-detected).
    monkeypatch.setattr(shared.milestones, "send_push",
                        lambda *a, **k: {"sent": 1, "ok": 0, "pruned": []})
    notify = RecordingNotifyRepo()
    plan = [_row("Deposit", "480000", id="a"), _row("Halfway", "300000", id="b")]
    sent = shared.milestones.notify_milestone_crossing(
        Decimal("500000"), Decimal("290000"),
        loanfacts_repo=FakeLoanFactsRepo(FACTS), device_repo=FakeDeviceRepo(),
        notify_repo=notify, milestone_repo=RecordingMilestoneRepo(stored=plan), scope="u1")
    assert sent == 1
    assert notify.fired == {"id:a:bal:480000.00", "id:b:bal:300000.00"}  # both marked
    assert notify.mark_scopes == ["u1", "u1"]                            # both under the scope


# --- a SAVED plan is NOT guarded by the strictly-paid-down import assert --------------------

def test_out_of_order_user_plan_still_fires_furthest_and_marks_each(shared, recorder):
    # WHIT-369 — [A-ORDER-1] _assert_strictly_paid_down only guards the built-in default at
    # import; a user's SAVED plan is used as-is. crossed_milestones re-sorts by target, so an
    # out-of-order plan must still fire the furthest crossed and mark every crossed one.
    plan = [_row("Mid", "300000", id="b"), _row("Far", "120000", id="c"), _row("Near", "480000", id="a")]
    notify = RecordingNotifyRepo()
    sent = shared.milestones.notify_milestone_crossing(
        Decimal("500000"), Decimal("100000"),
        loanfacts_repo=FakeLoanFactsRepo(FACTS), device_repo=FakeDeviceRepo(),
        notify_repo=notify, milestone_repo=RecordingMilestoneRepo(stored=plan))
    assert sent == 1
    assert recorder[0][0] == "\U0001f389 Milestone reached — Far!"  # furthest = lowest (120000)
    assert notify.fired == {
        "id:a:bal:480000.00", "id:b:bal:300000.00", "id:c:bal:120000.00"}


# --- _plan_marker: byte-stability + collision-freedom for weird amounts / ids ---------------

def test_plan_marker_is_byte_stable_across_decimal_and_int_and_str_formats(shared):
    # WHIT-369 — [A-MARK-2] the marker must be identical however the stored amount formats, or
    # the same target re-fires every poll. int / str / trailing-zero Decimals all collapse.
    m = shared.milestones._plan_marker
    for tb in (Decimal("480000"), Decimal("480000.0"), Decimal("480000.00"), 480000, "480000"):
        assert m({"id": "m1", "targetBalance": tb}) == "id:m1:bal:480000.00"


def test_plan_marker_normalizes_scientific_notation(shared):
    # WHIT-369 — [A-MARK-3] a Decimal that stringifies as "1E+6" must quantize to a plain
    # "1000000.00" marker, not "1E+6", so it stays byte-stable across polls.
    assert shared.milestones._plan_marker(
        {"id": "m1", "targetBalance": Decimal("1E+6")}) == "id:m1:bal:1000000.00"


def test_plan_marker_numeric_string_id_cannot_collide_with_a_sprint_marker(shared):
    # WHIT-369 — [A-MARK-4] a saved milestone whose id is the string "0" must NOT produce the
    # bare "0" a built-in Kickoff sprint marks — the "id:...:bal:..." envelope keeps them apart.
    marker = shared.milestones._plan_marker({"id": "0", "targetBalance": Decimal("544000")})
    assert marker == "id:0:bal:544000.00"
    assert marker not in {"0", "1", "2", "3", "4"}


def test_plan_marker_id_with_a_colon_stays_distinct(shared):
    # WHIT-369 — [A-MARK-5] an id containing the ':' separator must not smear into a neighbour's
    # marker. "a:b" and "a" at the same amount stay distinct.
    m = shared.milestones._plan_marker
    a = m({"id": "a:b", "targetBalance": Decimal("480000")})
    b = m({"id": "a", "targetBalance": Decimal("480000")})
    assert a == "id:a:b:bal:480000.00"
    assert a != b


def test_plan_marker_missing_and_explicit_none_id_both_fall_back_to_amount(shared):
    # WHIT-369 — [A-MARK-6] a legacy row with no id, and a row with an explicit id=None, both
    # degrade to the amount-only marker rather than raising (a raise would be swallowed by the
    # poller into a silently-lost celebration).
    m = shared.milestones._plan_marker
    assert m({"targetBalance": Decimal("480000")}) == "bal:480000.00"
    assert m({"id": None, "targetBalance": Decimal("480000")}) == "bal:480000.00"
