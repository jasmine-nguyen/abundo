"""Tests for MilestoneRepository (shared/repository_milestone.py, WHIT-375).

Backed by the in-memory FakeTable (the `milestone_repo` fixture). Guarantees: get
returns None until saved (no seed), a save round-trips (targetBalance as float), a
second save overwrites in place, pk/sk stay internal, and the multi-tenant scope
seam lands different scopes at different keys.
"""

from decimal import Decimal
import pytest

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


# --- folded from test_repository_milestone_edges.py (WHIT-463) ---


def _store_raw_row(milestone_repo, milestones, scope="SHARED"):
    """Inject a stored row directly, bypassing set_milestones' validation, to mimic a
    legacy / partially-written row. Pass milestones=None for a row with no attribute."""
    row = {"pk": "MILESTONES", "sk": scope}
    if milestones is not None:
        row["milestones"] = milestones
    milestone_repo._table.store[("MILESTONES", scope)] = row


_COMPLETE = {"id": "m1", "label": "Halfway", "targetBalance": Decimal("300000"),
             "targetDate": "2030-01-01"}


def test_stored_empty_list_returns_empty_list_not_none(milestone_repo):
    # Distinct from "never saved" (None): if a row exists with an empty list, get must
    # return [] so a caller can tell "saved, currently empty" from "unset".
    milestone_repo.set_milestones([])
    assert milestone_repo.get_milestones() == []
    assert milestone_repo.get_milestones() is not None


def test_row_without_milestones_attribute_reads_as_none(milestone_repo):
    # A row exists at pk=MILESTONES but carries no `milestones` attribute (a legacy/partial
    # write). Both accessors must read it as "unset" (None), never KeyError-500.
    _store_raw_row(milestone_repo, None)
    assert milestone_repo.get_milestones() is None
    assert milestone_repo.get_milestones_raw() is None


_COMPLETE2 = {"id": "m2", "label": "Target", "targetBalance": Decimal("55000"),
              "targetDate": "2032-01-01"}


def _without(field):
    return {k: v for k, v in {**_COMPLETE, "id": "bad"}.items() if k != field}


@pytest.mark.parametrize("stored, expected_ids", [
    *(pytest.param([_COMPLETE, _without(field)], ["m1"], id=f"missing-{field}")
      for field in ("id", "label", "targetBalance", "targetDate")),
    pytest.param([_COMPLETE, {**_COMPLETE, "id": "bad", "targetBalance": None}], ["m1"], id="null-target"),
    pytest.param([_COMPLETE, {**_COMPLETE, "id": "bad", "targetBalance": "not-a-number"}], ["m1"],
                 id="non-numeric-target"),
    *(pytest.param([_COMPLETE, junk, _COMPLETE2], ["m1", "m2"], id=f"non-dict-{type(junk).__name__}")
      for junk in ("a string", None, 42, ["nested"])),
    pytest.param([_COMPLETE2, {**_COMPLETE, "id": "bad", "targetBalance": None}, _COMPLETE], ["m2", "m1"],
                 id="survivors-keep-stored-order"),
    *(pytest.param(scalar, [], id=f"scalar-{scalar!r}") for scalar in (5, Decimal("5"), True)),
    pytest.param({"m1": _COMPLETE}, [], id="dict"),
    pytest.param("corrupt", [], id="string"),
])
def test_client_read_skips_bad_rows_and_degrades_bad_shapes_to_empty(milestone_repo, stored, expected_ids):
    # A corrupt stored row never 500s the client read: bad rows are skipped, a non-list is [].
    _store_raw_row(milestone_repo, stored)
    assert [m["id"] for m in milestone_repo.get_milestones()] == expected_ids


@pytest.mark.parametrize("stored", [
    pytest.param([{"id": "bad", "label": "no balance", "targetDate": "2030-01-01"}], id="partial-row"),
    pytest.param({"m1": _COMPLETE}, id="non-list"),
])
def test_poller_resolve_degrades_a_corrupt_plan_to_empty_not_the_default(shared, milestone_repo, stored):
    # WHIT-387: corrupt data is skipped by the plan read, never raised into the poller's swallow
    # and never replaced by the default plan (a wrong default celebration).
    _store_raw_row(milestone_repo, stored)
    assert shared.milestones._resolve_plan(milestone_repo)[0] == []
