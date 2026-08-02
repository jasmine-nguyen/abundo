"""WHIT-394 — [B1]-[B5] adversarial GAPS in the shared row validator, INDEPENDENT of the
implementer's tests/shared/test_milestone_rows.py.

They already lock: the validator's accept/reject table, the client read's new non-finite /
blank-label / bad-date rejections, a 13-shape parity table across both read paths, the
per-site log level + alarm token, Decimal-vs-float, and the WHIT-378 null-id tolerance.

What that table does NOT do is pin the divergences it leaves open, or the WHIT-385 marker
interaction the new poller-side rejection creates:

  [B1] PIN: targetDate is a CLIENT-ONLY rule, so a row with an unparsable date is invisible
       on the plan screen yet STILL celebrates a push from the poller. A real, user-visible
       inconsistency the card's approved scope accepts — pinned so it stays chosen, not drift.
  [B2] PIN: a row with NO `id` KEY (not a null id) is dropped by the client and KEPT by the
       poller. The implementer's "both paths tolerate a legacy id-less row" test uses
       {"id": None}; the genuinely key-less legacy row diverges. WHIT-378 carve-out, approved.
  [B3] WHIT-394 x WHIT-385: rejecting a blank label on the POLLER path is NEW, so a row that
       already celebrated now resolves out of the plan and its marker goes stale. The sweep
       must remove ONLY that marker and leave every healthy row's "already celebrated"
       record intact.
  [B4] the missing-field-vs-bad-value nesting trap, for row_date. The implementer pinned it
       for row_target only; row_date has the same `except ValueError` around a call whose
       error type IS a ValueError subclass.
  [B5] the EXACT float-overflow boundary: sys.float_info.max is accepted, the first value
       past it is rejected. The implementer's 1e300-ok / 1e309-bad pair leaves a 9-order-of-
       magnitude gap either an over-strict cap or a missing check could hide in.
"""

import sys
from decimal import Decimal

import pytest


def _store_raw_row(milestone_repo, milestones, scope="SHARED"):
    milestone_repo._table.store[("MILESTONES", scope)] = {
        "pk": "MILESTONES", "sk": scope, "milestones": milestones,
    }


_GOOD = {"id": "keep", "label": "Halfway", "targetBalance": Decimal("300000"),
         "targetDate": "2030-01-01"}


def _row(**overrides):
    return {**_GOOD, **overrides}


class FakeMilestoneRepo:
    def __init__(self, stored):
        self._stored = stored

    def get_milestones_raw(self, scope=None):
        return self._stored


class FakeDeviceRepo:
    def list_tokens(self):
        return ["tok"]


class FakeLoanFactsRepo:
    def get_loanfacts(self):
        return None          # the number-free body; the figures aren't what's under test


class FakeNotifyRepo:
    def __init__(self, fired=None):
        self.fired = set(fired or set())
        self.removed = set()

    def fired_milestones(self, scope=None):
        return set(self.fired)

    def mark_milestone_fired(self, key, scope=None):
        self.fired.add(key)

    def remove_milestone_markers(self, keys, scope=None):
        assert keys, "must guard empty before calling remove_milestone_markers"
        self.removed |= set(keys)
        self.fired -= set(keys)


@pytest.fixture
def recorder(shared, monkeypatch):
    calls = []
    monkeypatch.setattr(shared.milestones, "send_push",
                        lambda title, body, tokens, **kw: calls.append((title, body, tokens)))
    return calls


def _notify(shared, *, old, new, stored, notify=None):
    notify = notify or FakeNotifyRepo()
    sent = shared.milestones.notify_milestone_crossing(
        Decimal(old), Decimal(new),
        loanfacts_repo=FakeLoanFactsRepo(),
        device_repo=FakeDeviceRepo(),
        notify_repo=notify,
        milestone_repo=FakeMilestoneRepo(stored),
    )
    return sent, notify


# --- [B1] PIN: the date rule is shared, so a hidden row does NOT push --------

def test_a_bad_date_row_is_invisible_on_screen_and_does_not_push(shared, milestone_repo, recorder):
    # [B1] WHIT-417 DECIDED this. It used to diverge: targetDate was checked on the client path
    # only, so a row the plan screen hid still sent "Milestone reached - Dated!" — the user
    # tapped the celebration and landed on a plan that milestone wasn't in. Both paths now
    # apply the same rule, so what pushes is what the screen shows.
    # Fail-on-revert (either direction): drop row_date from _resolve_plan and the row pushes
    # again; drop it from _to_client and the screen stops hiding it. Either way, red.
    stored = [_GOOD, {"id": "d", "label": "Dated", "targetBalance": Decimal("120000"),
                      "targetDate": "not-a-date"}]
    _store_raw_row(milestone_repo, stored)

    assert [m["id"] for m in milestone_repo.get_milestones()] == ["keep"]   # screen: gone
    assert [p.label for p in shared.milestones.resolve_plan(FakeMilestoneRepo(stored))] == [
        "Halfway"]                                                         # poller: gone too

    # A poll whose balance crosses the bad row's target celebrates nothing, and records nothing.
    sent, notify = _notify(shared, old="130000", new="119000", stored=stored)
    assert sent == 0
    assert recorder == []
    assert "id:d:bal:120000.00" not in notify.fired


def test_a_bad_date_row_that_already_celebrated_sweeps_only_its_own_marker(shared, recorder):
    # [B1a] WHIT-417 x WHIT-385, the same shape [B3] pins for blank labels. Rejecting a bad
    # date on the poller path is NEW, so a row that celebrated before this change now resolves
    # out of the plan and its marker goes stale. The sweep must take THAT key and nothing else.
    # Fail-on-revert: drop row_date from _resolve_plan -> the row resolves, its marker is live,
    # nothing is swept, and `removed` is empty.
    stored = [_GOOD, _row(id="dated", label="Dated", targetBalance=Decimal("250000"),
                          targetDate="not-a-date")]
    keep_marker, dated_marker = "id:keep:bal:300000.00", "id:dated:bal:250000.00"
    notify = FakeNotifyRepo(fired={keep_marker, dated_marker, "0"})

    # A no-crossing poll: the sweep runs on its own, before any celebration logic.
    sent, notify = _notify(shared, old="500000", new="450000", stored=stored, notify=notify)

    assert sent == 0
    assert recorder == []
    assert notify.removed == {dated_marker}          # only the newly-invalid row's marker
    assert keep_marker in notify.fired               # healthy row's record intact
    assert "0" in notify.fired                       # built-in sprint marker never swept


def test_a_repaired_date_can_celebrate_again_after_its_marker_was_swept(shared, recorder):
    # [B1b] The honest downside of WHIT-417, pinned so it is known rather than discovered.
    # The "already celebrated" marker is what makes a celebration once-ever (it is written with
    # no expiry — repository_notify.py). Rejecting the row makes that marker stale, so the sweep
    # deletes it. If the date is later repaired AND the balance has since risen back above the
    # target (a redraw, an extra draw, or capitalised interest — the balance does NOT only fall),
    # the crossing is detected again and the user is congratulated a second time.
    # Accepted: it needs a hand-edited row, a repair, and a balance rise. Cheaper than keeping a
    # dead marker for a row that is no longer in the plan.
    #
    # A healthy row has to sit alongside the broken one for the sweep to run at all: a plan that
    # resolves to EMPTY sweeps nothing (the WHIT-386 `and plan` guard, pinned by [B1c]). So the
    # re-fire is narrower still — it needs the rest of the plan to survive.
    broken = _row(id="dated", label="Dated", targetBalance=Decimal("250000"),
                  targetDate="not-a-date")
    marker = "id:dated:bal:250000.00"
    notify = FakeNotifyRepo(fired={marker})

    # 1. While broken, a no-crossing poll sweeps the stale marker.
    _notify(shared, old="500000", new="450000", stored=[_GOOD, broken], notify=notify)
    assert notify.removed == {marker}
    assert marker not in notify.fired

    # 2. The date is repaired and the balance crosses the target again.
    repaired = _row(id="dated", label="Dated", targetBalance=Decimal("250000"),
                    targetDate="2030-01-01")
    sent, notify = _notify(shared, old="260000", new="240000", stored=[_GOOD, repaired],
                           notify=notify)

    assert sent == 1
    assert recorder[-1][0] == "\U0001f389 Milestone reached — Dated!"
    assert marker in notify.fired                    # re-armed, so it can't fire a third time


def test_a_plan_where_every_row_has_a_bad_date_celebrates_nothing(shared, recorder):
    # [B1c] The whole-plan case. Every row is hidden from the screen, so the app falls back to
    # showing the built-in starter plan — but the poller must NOT celebrate the saved rows it
    # can no longer resolve, and must NOT fall back to the built-in plan either (that would
    # send a celebration for a milestone the user never saved). An authoritative empty plan
    # celebrates nothing and, via the WHIT-386 `and plan` guard, sweeps nothing.
    # Fail-on-revert: drop row_date from _resolve_plan -> both rows resolve and push.
    stored = [_row(id="a", label="A", targetBalance=Decimal("300000"), targetDate="not-a-date"),
              _row(id="b", label="B", targetBalance=Decimal("250000"), targetDate="")]
    notify = FakeNotifyRepo(fired={"0"})

    sent, notify = _notify(shared, old="500000", new="200000", stored=stored, notify=notify)

    assert sent == 0
    assert recorder == []
    assert notify.removed == set()                   # nothing swept on an empty plan
    assert "0" in notify.fired


# --- [B2] PIN: a row with no `id` KEY diverges (WHIT-378 carve-out) ---------

def test_a_row_with_no_id_key_at_all_is_dropped_by_the_client_and_kept_by_the_poller(
        shared, milestone_repo):
    # [B2] The implementer's WHIT-378 test uses {"id": None} — a PRESENT key — where both
    # paths agree. A row saved before ids were minted has no `id` key at all: _to_client's
    # row_field(m, "id") raises (repository_milestone.py:66) and drops it, while
    # _plan_marker's milestone.get("id") (milestones.py:82) falls back to "bal:<amount>".
    # The card froze id handling on both paths, so this is deliberate — pinned so a future
    # "unify the last field too" change is a conscious decision, not a silent one.
    legacy = {"label": "Old", "targetBalance": Decimal("480000"), "targetDate": "2030-01-01"}
    _store_raw_row(milestone_repo, [_GOOD, legacy])

    assert [m["id"] for m in milestone_repo.get_milestones()] == ["keep"]
    plan = shared.milestones.resolve_plan(FakeMilestoneRepo([_GOOD, legacy]))
    assert [p.key for p in plan] == ["id:keep:bal:300000.00", "bal:480000.00"]


# --- [B3] the NEW poller-side rejection vs the WHIT-385 marker sweep --------

def test_a_newly_rejected_blank_label_row_sweeps_only_its_own_marker(shared, recorder):
    # [B3] Before WHIT-394 the poller accepted a blank label (only a MISSING key was caught),
    # so such a row could already have celebrated and be sitting in the fired set. Now it
    # resolves OUT of the plan, which makes its marker stale to the WHIT-385 reconcile.
    # The invariant that matters: the sweep takes THAT key and nothing else — one newly
    # invalid row must not cost the healthy rows their once-ever "already celebrated" record.
    # Fail-on-revert: drop the blank check from milestone_rows.row_text -> the row resolves,
    # its marker is live, nothing is swept, and `removed` is empty.
    stored = [
        _row(id="keep", label="Halfway", targetBalance=Decimal("300000")),
        {"id": "blank", "label": "   ", "targetBalance": Decimal("250000"),
         "targetDate": "2031-01-01"},
    ]
    keep_marker, blank_marker = "id:keep:bal:300000.00", "id:blank:bal:250000.00"
    notify = FakeNotifyRepo(fired={keep_marker, blank_marker, "0"})   # "0" = built-in sprint

    # A no-crossing poll: the sweep runs on its own, before any celebration logic.
    sent, notify = _notify(shared, old="500000", new="450000", stored=stored, notify=notify)

    assert sent == 0
    assert recorder == []
    assert notify.removed == {blank_marker}          # only the newly-invalid row's marker
    assert keep_marker in notify.fired               # healthy row's record intact
    assert "0" in notify.fired                       # built-in sprint marker never swept


# --- [B4] the nesting trap, for row_date this time --------------------------

def test_a_missing_target_date_is_not_rewrapped_as_unparsable(shared):
    # [B4] row_date wraps date.fromisoformat in `except ValueError`, and
    # MalformedMilestoneRow IS a ValueError — so if row_field is ever moved inside that try,
    # a MISSING targetDate is caught and re-raised as "unparsable", destroying the log line
    # that tells you which field is actually broken. The implementer pinned this for
    # row_target; row_date has the identical shape and was left unpinned.
    rows = shared.milestone_rows
    with pytest.raises(rows.MalformedMilestoneRow, match="missing targetDate"):
        rows.row_date({"id": "m1", "label": "No date"}, "targetDate")
    with pytest.raises(rows.MalformedMilestoneRow, match="unparsable targetDate"):
        rows.row_date(_row(targetDate="not-a-date"), "targetDate")


# --- [B5] the exact float-overflow boundary ---------------------------------

def test_the_float_overflow_boundary_is_exactly_the_largest_float(shared):
    # [B5] The implementer pins 1e300 (ok) and 1e309 (rejected), leaving the real edge —
    # sys.float_info.max, ~1.797e308 — untested in between. The largest representable float
    # must still be READ (an over-strict cap would silently delete a legitimate row), and the
    # first value past it must be rejected (float() turns it into inf, which serialises as a
    # bare Infinity token). Fail-on-revert: drop the math.isfinite check in row_target_float
    # -> the second half returns inf instead of raising.
    largest = Decimal(repr(sys.float_info.max))
    assert shared.milestone_rows.row_target_float(_row(targetBalance=largest)) == sys.float_info.max

    just_over = Decimal("1.8e308")          # > 1.7976931348623157e308, still << 1e309
    assert just_over.is_finite()            # a perfectly fine Decimal...
    with pytest.raises(shared.milestone_rows.MalformedMilestoneRow):
        shared.milestone_rows.row_target_float(_row(targetBalance=just_over))
