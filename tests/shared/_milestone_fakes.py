"""Shared fakes for the milestone test family (WHIT-445).

A dozen milestone suites (test_milestones*, test_milestone_rows*, the resolve/live-keys/
custom-plan gap suites) each carried their own near-identical copies of these repo fakes.
A copied fake drifts — a FakeNotifyRepo that quietly drops the marker String-Set assert, or
a FakeMilestoneRepo that stops honouring `scope`, starts passing what the real repositories
reject. They live here now, in ONE definition each, so every suite imports them.

The classes are SUPERSETS: they carry the union of every counter / scope-log the suites
assert on (`reads`, `remove_calls`, `removed`, `fired_scopes`, `mark_scopes`, `scopes_read`),
all inert when unused, and the widest constructor signature, so a suite that used a narrower
copy imports this one unchanged. The per-suite `_notify` / `_run` harness helpers stay local
to each file — they call the real notify_milestone_crossing with different contracts (some
return the sent count, some the (sent, notify) pair) and are scaffolding, not drift-prone fakes.

Resolved by pytest.ini's `pythonpath = tests/shared`. `recorder` needs the `shared` fixture
(conftest.py) to monkeypatch send_push; importing a fixture into a test module registers it.
"""

from decimal import Decimal

import pytest


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


class FakeNotifyRepo:
    """Superset stand-in for NotifyRepository's milestone-marker String Set.

    Records reads and reconcile calls and logs the scope each was made under, so the plain,
    counting, and scope-recording suites are all served by this one fake. mark keeps the
    isinstance(str) assert that mirrors DynamoDB's String-Set constraint (a marker that isn't
    a str is the very regression the assert exists to catch)."""

    def __init__(self, fired=None):
        self.fired = set(fired or set())
        self.removed = set()      # every key ever passed to remove_milestone_markers
        self.reads = 0            # fired_milestones call count
        self.remove_calls = 0     # remove_milestone_markers call count
        self.fired_scopes = []    # scope logged on each read
        self.mark_scopes = []     # scope logged on each mark

    def fired_milestones(self, scope=None):
        self.reads += 1
        self.fired_scopes.append(scope)
        return set(self.fired)

    def mark_milestone_fired(self, key, scope=None):
        assert isinstance(key, str), "marker must be a string (String Set)"
        self.mark_scopes.append(scope)
        self.fired.add(key)

    def remove_milestone_markers(self, keys, scope=None):
        assert keys, "must guard empty before calling remove_milestone_markers"
        self.remove_calls += 1
        self.removed |= set(keys)
        self.fired -= set(keys)


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


@pytest.fixture
def recorder(shared, monkeypatch):
    """Replace shared.milestones.send_push with a recorder that returns an all-ok receipt."""
    calls = []

    def fake(title, body, tokens, **kw):
        calls.append((title, body, tokens))
        return {"sent": len(tokens), "ok": len(tokens), "pruned": []}

    monkeypatch.setattr(shared.milestones, "send_push", fake)
    return calls
