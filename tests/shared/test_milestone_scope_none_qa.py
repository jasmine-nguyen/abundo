"""WHIT-793 QA — milestones._resolve_plan now always calls get_milestones_raw(scope), so the real
repository must read the shared tenant when scope is None (the poller's single-tenant call)."""

from decimal import Decimal

_PLAN = [{"id": "a", "label": "Kickoff", "targetBalance": Decimal("544000"), "targetDate": "2026-06-18"}]


def test_a_none_scope_reads_the_shared_plan_through_the_real_repository(shared, milestone_repo):
    # [A1] save under the default (shared) scope, then resolve with scope=None → the saved plan,
    # authoritative. If None reached the key it would read nothing and resolve to an empty plan.
    milestone_repo.set_milestones(_PLAN)
    milestone_repo.set_milestones([{**_PLAN[0], "id": "u"}], scope="user-x")

    assert milestone_repo.get_milestones_raw(None)[0]["id"] == "a"
    plan, authoritative, _ = shared.milestones._resolve_plan(milestone_repo, None)
    assert authoritative is True
    assert [row.key for row in plan] == ["id:a:bal:544000.00"]
    user_plan, _, _ = shared.milestones._resolve_plan(milestone_repo, "user-x")
    assert [row.key for row in user_plan] == ["id:u:bal:544000.00"]
