"""Tests for MilestoneRepository (shared/repository_milestone.py, WHIT-375).

Backed by the in-memory FakeTable (the `milestone_repo` fixture). Guarantees: get
returns None until saved (no seed), a save round-trips (targetBalance as float), a
second save overwrites in place, pk/sk stay internal, and the multi-tenant scope
seam lands different scopes at different keys.
"""

from decimal import Decimal

_PLAN = [
    {"id": "a", "label": "Kickoff", "targetBalance": Decimal("544000"), "targetDate": "2026-06-18"},
    {"id": "b", "label": "Halfway", "targetBalance": Decimal("295000"), "targetDate": "2027-12-18"},
    {"id": "c", "label": "Target", "targetBalance": Decimal("55000"), "targetDate": "2029-06-18"},
]


def test_get_returns_none_before_any_save(milestone_repo):
    assert milestone_repo.get_milestones() is None


def test_save_then_get_round_trips_balance_as_float(milestone_repo):
    milestone_repo.set_milestones(_PLAN)
    assert milestone_repo.get_milestones() == [
        {"id": "a", "label": "Kickoff", "targetBalance": 544000.0, "targetDate": "2026-06-18"},
        {"id": "b", "label": "Halfway", "targetBalance": 295000.0, "targetDate": "2027-12-18"},
        {"id": "c", "label": "Target", "targetBalance": 55000.0, "targetDate": "2029-06-18"},
    ]


def test_set_echoes_the_saved_list_as_floats(milestone_repo):
    # The write echoes the saved list so the handler can return assigned ids to the client.
    saved = milestone_repo.set_milestones(_PLAN)
    assert [m["id"] for m in saved] == ["a", "b", "c"]
    assert saved[0]["targetBalance"] == 544000.0


def test_save_overwrites_in_place(milestone_repo):
    milestone_repo.set_milestones(_PLAN)
    milestone_repo.set_milestones(_PLAN[:1])
    got = milestone_repo.get_milestones()
    assert [m["id"] for m in got] == ["a"]
    assert len(milestone_repo._table.store) == 1   # one row, latest wins


def test_get_surfaces_only_the_four_fields(milestone_repo):
    milestone_repo.set_milestones(_PLAN)
    for m in milestone_repo.get_milestones():
        assert set(m) == {"id", "label", "targetBalance", "targetDate"}   # no pk/sk leaked


def test_get_raw_returns_none_before_any_save(milestone_repo):
    assert milestone_repo.get_milestones_raw() is None


def test_get_raw_preserves_target_balance_as_decimal(milestone_repo):
    # The poller path (WHIT-384) needs exact Decimals; get_milestones floats them, get_milestones_raw
    # must not — so a custom cent boundary stays exact.
    milestone_repo.set_milestones(_PLAN)
    raw = milestone_repo.get_milestones_raw()
    assert [m["targetBalance"] for m in raw] == [Decimal("544000"), Decimal("295000"), Decimal("55000")]
    assert all(isinstance(m["targetBalance"], Decimal) for m in raw)


def test_scope_isolates_rows(milestone_repo):
    # The multi-tenant seam: a non-default scope lands at a different key, so the shared
    # scope still reads None. Proves per-user isolation lives in the sort key.
    milestone_repo.set_milestones(_PLAN, scope="user-x")
    assert milestone_repo.get_milestones() is None                       # default SHARED scope
    assert [m["id"] for m in milestone_repo.get_milestones(scope="user-x")] == ["a", "b", "c"]
    assert len(milestone_repo._table.store) == 1
