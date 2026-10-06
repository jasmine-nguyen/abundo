"""Shared fakes for the milestone test family (WHIT-445, WHIT-625).

The milestone suites (test_milestones*, test_milestone_rows*) share these in ONE definition each:

  * the marker store is the REAL NotifyRepository over a FakeTable (``notify_repo``), so the
    String-Set ADD/DELETE and the per-owner keys run as production wrote them. The views
    (``stored_markers``, ``removed_markers``, ``scopes_read``, ...) read the table and its
    recorders, not a copied rule;
  * ``goal_checkpoint_repo`` / ``checkpoints_marked`` do the same for the goal-checkpoint
    markers (test_goal_checkpoints*);
  * FakeDeviceRepo, FakeLoanFactsRepo and FakeMilestoneRepo are read-only canned stubs.

The per-suite `_notify` / `_run` harness helpers stay local to each file — they call the real
notify_milestone_crossing with different contracts and are scaffolding, not drift-prone fakes.

Resolved by pytest.ini's `pythonpath = tests/shared`. `recorder` needs the `shared` fixture
(conftest.py) to monkeypatch send_push; importing a fixture into a test module registers it. The
shared layer is imported lazily, inside ``notify_repo``.
"""

from decimal import Decimal

import pytest

from _dynamo_fakes import FakeTable


# The partition key of the milestone marker items, one per owner (shared/repository_notify.py).
_MARKERS_PK = "NOTIFY#MILESTONE"
_GOALCHECKPOINT_PK = "NOTIFY#GOALCHECKPOINT"

# The loanfacts figures the crossing maths reads. One shape, shared by every plan-family suite.
FACTS = {"original": 600000.0, "homeValue": 770000.0, "lvr": 0.8,
         "ratePct": 5.95, "baseRepay": 3570.0, "extra": 12000.0, "payoffGoalDate": None}


def _row(label, balance, id="m1", date="2027-01-01"):
    """A stored custom-plan milestone row (targetBalance as Decimal, like get_milestones_raw)."""
    return {"id": id, "label": label, "targetBalance": Decimal(str(balance)), "targetDate": date}


class FakeDeviceRepo:
    """Stand-in for DeviceRepository. `tokens` defaults to one push token; pass an explicit
    tuple to exercise the multi-device / no-device fan-out."""

    def __init__(self, tokens=("tok",)):
        self._tokens = tokens

    def list_tokens(self):
        return list(self._tokens)


class FakeLoanFactsRepo:
    """Stand-in for LoanFactsRepository. `facts=None` models the no-loanfacts path; the
    row-family suites construct it with no args (the figures aren't what they test)."""

    def __init__(self, facts=None):
        self._facts = facts

    def get_loanfacts(self):
        return self._facts


def notify_repo(fired=None, scope=None):
    """The REAL NotifyRepository over its own FakeTable (WHIT-625), with ``fired`` already
    celebrated for ``scope`` through the real ``mark_milestone_fired``. The table's write log is
    cleared after that setup, so the views below see only what the code under test did."""
    from repository_notify import NotifyRepository

    repo = NotifyRepository()
    repo._table = FakeTable()
    for marker in fired or ():
        repo.mark_milestone_fired(marker, scope)
    repo._table.update_calls.clear()
    repo._table.update_keys.clear()
    return repo


def recording_notify_repo(fired=()):
    """``notify_repo(fired)`` plus a spy that records every migrate call (its migrations and scope)
    before the real rename runs, so a handler test can assert WHAT set_milestones migrates."""
    notify = notify_repo(fired)
    notify.migrate_calls = []
    migrate = notify.migrate_milestone_markers

    def spy(migrations, scope=None):
        notify.migrate_calls.append({"migrations": list(migrations), "scope": scope})
        return migrate(migrations, scope=scope)

    notify.migrate_milestone_markers = spy
    return notify


def goal_checkpoint_repo(fired=()):
    """The REAL NotifyRepository over its own FakeTable, with ``fired`` goal-checkpoint markers
    already set through the real ``mark_goal_checkpoint_fired``. The write log is cleared after
    that setup, like ``notify_repo``."""
    from repository_notify import NotifyRepository

    repo = NotifyRepository()
    repo._table = FakeTable()
    for marker in fired:
        repo.mark_goal_checkpoint_fired(marker)
    repo._table.update_calls.clear()
    repo._table.update_keys.clear()
    return repo


def _marker_writes(repo, verb, pk=_MARKERS_PK):
    return [(key, values) for key, (expression, _names, values)
            in zip(repo._table.update_keys, repo._table.update_calls)
            if key["pk"] == pk and expression.startswith(verb)]


def checkpoints_marked(repo):
    """Each goal-checkpoint marker the code set (ADD), in write order."""
    return [marker for _key, values in _marker_writes(repo, "ADD", _GOALCHECKPOINT_PK)
            for marker in sorted(values[":m"])]


def stored_markers(repo):
    """Every milestone marker the table holds now, across every owner (scope)."""
    markers = set()
    for (pk, _sk), item in repo._table.store.items():
        if pk == _MARKERS_PK:
            markers |= item.get("fired", set())
    return markers


def removed_markers(repo):
    """Every marker the code asked to remove (the DELETE writes)."""
    removed = set()
    for _key, values in _marker_writes(repo, "DELETE"):
        removed |= values[":m"]
    return removed


def removal_calls(repo):
    """How many DELETE writes reached the table."""
    return len(_marker_writes(repo, "DELETE"))


def marker_reads(repo):
    """How many times the marker set was read."""
    return len(scopes_read(repo))


def scopes_read(repo):
    """The sort key (owner) of each marker-set read, in order. The shared tenant's is "FIRED"."""
    return [key["sk"] for key in repo._table.get_item_keys if key["pk"] == _MARKERS_PK]


def scopes_marked(repo):
    """The sort key (owner) of each marker ADD, in order. The shared tenant's is "FIRED"."""
    return [key["sk"] for key, _values in _marker_writes(repo, "ADD")]


class FakeMilestoneRepo:
    """Scope-aware stand-in for MilestoneRepository. `stored` is the RAW list for the default
    (None) scope; `by_scope` maps a non-None scope to its own raw list; `raises` simulates a
    read failure. Records every scope it was read with, so the multi-tenant seam can be
    asserted. The widest of the family's shapes — a suite that used a narrower copy
    (no scope, no by_scope, no raises) imports this one unchanged."""

    def __init__(self, stored=None, raises=None, by_scope=None):
        self._stored = stored
        self._raises = raises
        self._by_scope = by_scope or {}
        self.scopes_read = []

    def get_milestones_raw(self, scope=None):
        self.scopes_read.append(scope)
        if self._raises is not None:
            raise self._raises
        if scope is not None and scope in self._by_scope:
            return self._by_scope[scope]
        return self._stored


def unreadable_milestone_repo():
    """A milestone store whose read fails, so the poller measures against the built-in plan."""
    return FakeMilestoneRepo(raises=RuntimeError("milestone store unreadable"))


def resolved_plan(shared, milestone_repo, scope=None):
    """The plan the celebration push measures against, as the poller resolves it."""
    return shared.milestones._resolve_plan(milestone_repo, scope)[0]


@pytest.fixture
def recorder(shared, monkeypatch):
    """Replace shared.milestones.send_push with a recorder that returns an all-ok receipt."""
    calls = []

    def fake(title, body, tokens, **kw):
        calls.append((title, body, tokens))
        return {"sent": len(tokens), "ok": len(tokens), "pruned": []}

    monkeypatch.setattr(shared.milestones, "send_push", fake)
    return calls
