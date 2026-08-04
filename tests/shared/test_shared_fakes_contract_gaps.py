"""WHIT-445 gap coverage — pin the SUPERSET fakes' behavioural contract.

The four AST invariants guards prove single-definition + no-redefinition + dependency-light.
They do NOT prove the consolidated SUPERSET fakes stay behaviourally faithful. When a dozen
suites' near-identical copies collapse into one widest fake, a future edit that NARROWS that
fake (drops the String-Set assert, stops honouring `scope`, loses a counter) would silently
weaken every suite at once while all of them stay green. These tests pin the union's contract
so such a narrowing reddens here. Not duplicated by the AST guards (which never construct the
fakes) nor by the suites under test (each exercises only the slice it happens to use).

Pure — no conftest fixture; the fakes are plain stdlib classes on pytest.ini's
`pythonpath = tests/shared`.
"""

from decimal import Decimal

import pytest

from _milestone_fakes import FakeMilestoneRepo, FakeNotifyRepo, recorder  # noqa: F401 (fixture)
import _milestone_fakes
import _milestone_row_fakes


# --- [C1] FakeNotifyRepo keeps the String-Set marker assert for EVERY suite -----------------

def test_notify_mark_rejects_a_non_string_marker():
    # The superset restored this assert that several suites' local fakes had dropped. It mirrors
    # DynamoDB's String-Set constraint: a non-str marker is the very regression the assert exists
    # to catch. Fail-on-revert: delete `assert isinstance(key, str)` from mark_milestone_fired and
    # this passes silently — meaning no milestone suite would ever catch a non-str marker again.
    repo = FakeNotifyRepo()
    with pytest.raises(AssertionError):
        repo.mark_milestone_fired(123)          # an int marker must never be accepted
    repo.mark_milestone_fired("0")              # a str marker is fine
    assert "0" in repo.fired


def test_notify_remove_guards_against_an_empty_key_set():
    # remove_milestone_markers must be guarded by the caller — the fake asserts the guard held.
    # Fail-on-revert: drop the `assert keys` and an empty remove silently no-ops instead of
    # flagging the missing guard the suites rely on.
    repo = FakeNotifyRepo(fired={"a"})
    with pytest.raises(AssertionError):
        repo.remove_milestone_markers(set())
    repo.remove_milestone_markers({"a"})
    assert "a" not in repo.fired


def test_notify_superset_counters_and_scope_logs_all_record():
    # The union of every counter/scope-log the family asserts on. If a future narrowing drops any
    # of these attributes, the suites that read it (live_keys [L4] reads, the scope suites'
    # mark_scopes/fired_scopes) break — this pins all of them in one place.
    repo = FakeNotifyRepo(fired={"seed"})
    repo.fired_milestones("SCOPE_A")
    repo.fired_milestones("SCOPE_A")
    repo.mark_milestone_fired("0", "SCOPE_A")
    repo.remove_milestone_markers({"seed"}, "SCOPE_A")
    assert repo.reads == 2
    assert repo.remove_calls == 1
    assert repo.removed == {"seed"}
    assert repo.fired_scopes == ["SCOPE_A", "SCOPE_A"]
    assert repo.mark_scopes == ["SCOPE_A"]


# --- [C2] FakeMilestoneRepo stays scope-aware (widest ctor) ----------------------------------

def test_milestone_repo_routes_by_scope_and_records_reads():
    # The scope-aware seam: a non-None scope present in by_scope returns ITS list; otherwise the
    # default `stored`. Fail-on-revert: revert get_milestones_raw to `return self._stored` and the
    # by_scope routing the multi-tenant (WHIT-369) suites assert on is gone.
    repo = FakeMilestoneRepo(stored=["default"], by_scope={"u1": ["scoped"]})
    assert repo.get_milestones_raw() == ["default"]           # None scope → stored
    assert repo.get_milestones_raw("u1") == ["scoped"]        # known scope → its list
    assert repo.get_milestones_raw("u2") == ["default"]       # unknown scope → falls back
    assert repo.scopes_read == [None, "u1", "u2"]             # every scope logged


def test_milestone_repo_raises_when_configured():
    # The read-failure seam (the resolve/reconcile best-effort paths lean on it). Fail-on-revert:
    # drop the `if self._raises` branch and the failure path can no longer be simulated.
    boom = RuntimeError("read blew up")
    repo = FakeMilestoneRepo(raises=boom)
    with pytest.raises(RuntimeError):
        repo.get_milestones_raw()
    assert repo.scopes_read == [None]        # the read was still logged before raising


def test_milestone_repo_stored_defaults_to_none():
    # The widest ctor made `stored` optional (row-family suites construct it with no args). A
    # narrowing back to a required positional would break those call sites.
    assert FakeMilestoneRepo().get_milestones_raw() is None


# --- [C3] the two same-named _row builders keep DISTINCT contracts ---------------------------
# _milestone_fakes._row(label, balance, ...) (Shape A) and _milestone_row_fakes._row(**overrides)
# (Shape B) share a name across two modules. They are NOT interchangeable; a future "dedupe" that
# collapses them would silently change what half the suites build. Pin both shapes so that reddens.

def test_shape_a_row_is_positional_label_balance_with_m1_default():
    row = _milestone_fakes._row("Halfway", 300000)
    assert row == {"id": "m1", "label": "Halfway",
                   "targetBalance": Decimal("300000"), "targetDate": "2027-01-01"}


def test_shape_b_row_is_kwargs_over_a_keep_default():
    row = _milestone_row_fakes._row()
    assert row["id"] == "keep"                       # distinct default from Shape A's "m1"
    assert row["targetBalance"] == Decimal("300000")
    assert _milestone_row_fakes._row(id="x")["id"] == "x"


def test_the_two_row_shapes_are_not_silently_mergeable():
    # Shape A REQUIRES positional label+balance; Shape B takes ONLY keyword overrides. Calling one
    # with the other's argument style raises — so an accidental cross-import fails loudly, and a
    # merge into one signature is caught here rather than by a mis-built row slipping through.
    with pytest.raises(TypeError):
        _milestone_fakes._row(id="x")                # Shape A has no such keyword-only call
    with pytest.raises(TypeError):
        _milestone_row_fakes._row("Halfway", 300000)  # Shape B takes no positionals
    assert _milestone_fakes._row("L", 1)["id"] != _milestone_row_fakes._row()["id"]


# --- [C4] the shared recorder hands back a realistic receipt (was None in some copies) --------

def test_recorder_returns_an_all_ok_receipt(recorder, shared):
    # Several suites' old recorders returned None (list.append's result); the shared one returns a
    # send_push-shaped receipt. Production discards the return, so this is inert for behaviour, but
    # pinning the shape keeps the fake honest to the real send_push contract it stands in for.
    sent = shared.milestones.send_push("t", "b", ["tokA", "tokB"], data={})
    assert sent == {"sent": 2, "ok": 2, "pruned": []}
    assert recorder == [("t", "b", ["tokA", "tokB"])]
