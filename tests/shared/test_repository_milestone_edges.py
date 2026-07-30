"""WHIT-375 — adversarial repository-level edges for MilestoneRepository, INDEPENDENT
of the implementer's tests/shared/test_repository_milestone.py.

Gaps covered (verified absent from the implementer's suite first):
  [R-EMPTY]  a stored item whose `milestones` is [] returns [] (not None, not a crash) —
             the "exists but empty" state is distinct from "never saved" (None).
  [R-CENTS]  a Decimal balance with cents (595413.43) round-trips to the exact float.
  [R-SCOPES] two DIFFERENT non-default scopes don't bleed into each other.
  [R-KEY]    the stored row key is pk=MILESTONES / sk=<scope> (seam lives in the sort key).
"""

from decimal import Decimal


def test_stored_empty_list_returns_empty_list_not_none(milestone_repo):
    # Distinct from "never saved" (None): if a row exists with an empty list, get must
    # return [] so a caller can tell "saved, currently empty" from "unset".
    milestone_repo.set_milestones([])
    assert milestone_repo.get_milestones() == []
    assert milestone_repo.get_milestones() is not None


def test_decimal_with_cents_round_trips_to_exact_float(milestone_repo):
    plan = [{"id": "a", "label": "Odd", "targetBalance": Decimal("595413.43"),
             "targetDate": "2026-06-18"}]
    milestone_repo.set_milestones(plan)
    got = milestone_repo.get_milestones()
    assert got[0]["targetBalance"] == 595413.43


def test_two_non_default_scopes_do_not_bleed(milestone_repo):
    # The impl test isolates one non-default scope from SHARED; this proves two
    # non-default tenants are independent — the multi-user isolation guarantee.
    plan_x = [{"id": "x1", "label": "X", "targetBalance": Decimal("100000"), "targetDate": "2026-06-18"}]
    plan_y = [{"id": "y1", "label": "Y", "targetBalance": Decimal("200000"), "targetDate": "2027-06-18"}]
    milestone_repo.set_milestones(plan_x, scope="user-x")
    milestone_repo.set_milestones(plan_y, scope="user-y")
    assert [m["id"] for m in milestone_repo.get_milestones(scope="user-x")] == ["x1"]
    assert [m["id"] for m in milestone_repo.get_milestones(scope="user-y")] == ["y1"]
    assert milestone_repo.get_milestones() is None      # SHARED still empty
    assert len(milestone_repo._table.store) == 2


def test_row_key_is_milestones_pk_and_scope_sk(milestone_repo):
    # Locks the physical key shape the multi-tenant seam depends on: pk fixed, sk=scope.
    plan = [{"id": "a", "label": "K", "targetBalance": Decimal("100000"), "targetDate": "2026-06-18"}]
    milestone_repo.set_milestones(plan, scope="user-z")
    assert ("MILESTONES", "user-z") in milestone_repo._table.store
