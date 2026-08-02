"""WHIT-394 — [B1]-[B5] adversarial GAPS in the shared row validator, INDEPENDENT of the
implementer's tests/shared/test_milestone_rows.py.

They already lock: the validator's accept/reject table, the client read's non-finite /
blank-label / bad-date rejections, a 16-shape parity table across both read paths, the
per-site log level + alarm token, Decimal-vs-float, and the WHIT-378 null-id tolerance.

What that table does NOT do is pin the divergences it leaves open, or the WHIT-385 marker
interaction each new poller-side rejection creates:

  [B1] PIN: WHIT-417 gave the date rule to BOTH paths, so a row the plan screen hides is no
       longer celebrated by the poller. It used to be: the user got a push naming a milestone
       the app doesn't show, and tapping it opened the plan screen where it isn't listed.
       Pinned in both directions so neither path can quietly drop the rule again.
  [B1b] the accepted COST of that decision: rejecting the row makes its "already celebrated"
       marker stale, so the sweep deletes it — a later repair plus a balance rise can
       celebrate a second time. Needs a healthy row alongside; an empty plan sweeps nothing.
  [B1c] the whole-plan case: every row bad-dated -> the poller celebrates nothing and sweeps
       nothing, rather than falling back to the built-in plan and celebrating a milestone the
       user never saved.
  [B2] PIN: a row with NO `id` KEY (not a null id) is dropped by the client and KEPT by the
       poller. The implementer's "both paths tolerate a legacy id-less row" test uses
       {"id": None}; the genuinely key-less legacy row diverges. WHIT-378 carve-out, approved.
       This is the last route to the push [B1] closed — equally hand-edit-only.
  [B3] each new poller-side rejection x WHIT-385: a row that already celebrated now resolves
       out of the plan and its marker goes stale. The sweep must remove ONLY that marker and
       leave every healthy row's "already celebrated" record intact. Covers the WHIT-394
       blank label and the WHIT-417 bad date.
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


def test_a_repaired_date_does_not_celebrate_again_because_its_marker_survived(shared, recorder):
    # [B1b] The once-ever guarantee has to survive a row being temporarily unreadable. The
    # "already celebrated" marker is what provides it (written with no expiry —
    # repository_notify.py). WHIT-417 made the poller reject a bad date, which used to make that
    # marker look stale and get swept — so repairing the date and crossing the target again
    # congratulated the user a second time for the same milestone. The marker now survives the
    # row being unreadable, so the repair is silent, which is what "once ever" has to mean.
    # Fail-on-revert: build the live set from `plan` again -> the marker is swept in step 1 and
    # the repaired row pushes in step 2.
    broken = _row(id="dated", label="Dated", targetBalance=Decimal("250000"),
                  targetDate="not-a-date")
    marker = "id:dated:bal:250000.00"
    notify = FakeNotifyRepo(fired={marker})

    # 1. While broken, a no-crossing poll leaves its marker alone. A healthy row sits alongside
    # so the sweep genuinely runs — an empty plan skips it entirely (WHIT-386, pinned by [B1c]).
    _notify(shared, old="500000", new="450000", stored=[_GOOD, broken], notify=notify)
    assert notify.removed == set()
    assert marker in notify.fired

    # 2. The date is repaired and the balance crosses the target again — already celebrated.
    repaired = _row(id="dated", label="Dated", targetBalance=Decimal("250000"),
                    targetDate="2030-01-01")
    sent, notify = _notify(shared, old="260000", new="240000", stored=[_GOOD, repaired],
                           notify=notify)

    assert sent == 0
    assert recorder == []


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

@pytest.mark.parametrize("bad_row, why", [
    ({"id": "bad", "label": "   ", "targetBalance": Decimal("250000"),
      "targetDate": "2031-01-01"}, "blank label (WHIT-394)"),
    ({"id": "bad", "label": "Dated", "targetBalance": Decimal("250000"),
      "targetDate": "not-a-date"}, "unparsable date (WHIT-417)"),
])
def test_an_unreadable_row_keeps_its_marker_but_a_deleted_one_loses_it(
        shared, recorder, bad_row, why):
    # [B3] The sweep removes markers for milestones that are GONE — deleted, or re-targeted so
    # they key to a new amount. Each time a read path gained a rejection (WHIT-394's blank
    # label, WHIT-417's bad date) an unreadable row started resolving out of the plan and looked
    # deleted too, so its once-ever record was wiped and the celebration could happen twice.
    # The live set is now built from every stored row we can KEY, so "unreadable" and "deleted"
    # are told apart. Both halves are asserted in one poll so neither can regress alone.
    # Fail-on-revert: build the live set from `plan` again -> the bad row's marker is swept.
    stored = [_row(id="keep", label="Halfway", targetBalance=Decimal("300000")), bad_row]
    keep_marker, bad_marker = "id:keep:bal:300000.00", "id:bad:bal:250000.00"
    gone_marker = "id:gone:bal:999000.00"            # a row genuinely no longer in the plan
    notify = FakeNotifyRepo(fired={keep_marker, bad_marker, gone_marker, "0"})

    # A no-crossing poll: the sweep runs on its own, before any celebration logic.
    sent, notify = _notify(shared, old="500000", new="450000", stored=stored, notify=notify)

    assert sent == 0
    assert recorder == []
    assert notify.removed == {gone_marker}, why      # only the row that is actually gone
    assert bad_marker in notify.fired, why           # unreadable != deleted
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
