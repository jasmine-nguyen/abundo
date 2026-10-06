"""WHIT-755 slice 2: one shared pay-cycle stand-in and one shared category stand-in.

  * the shared fakes gain a read counter and an optional "fail on purpose" error;
  * the budgets, breakdown, alerts, rules and mirror suites drop their own copies — guarded,
    under any name, by test_repo_fakes_by_behaviour.py (WHIT-766).
"""

import pytest


def test_shared_pay_cycle_and_category_fakes_count_reads_and_can_fail_on_purpose():
    from _budget_endpoint_fakes import _FakeCategoryRepo, _FakePayCycleRepo, _spend_cat
    from _feed_fakes import FakeCategoryRepo

    pay_cycle = _FakePayCycleRepo()
    assert pay_cycle.get_calls == 0
    assert pay_cycle.get_paycycle() == {"length": 30, "last_pay_date": "2026-07-01"}
    assert pay_cycle.get_paycycle() == {"length": 30, "last_pay_date": "2026-07-01"}
    assert pay_cycle.get_calls == 2
    assert _FakePayCycleRepo(length=14, last_pay_date="2024-01-03").get_paycycle() == {
        "length": 14, "last_pay_date": "2024-01-03"}

    empty = _FakeCategoryRepo()
    assert empty.list_calls == 0
    assert empty.list_categories() == []
    assert empty.list_calls == 1

    categories = _FakeCategoryRepo([{"id": "coffee", "bucket": "Lifestyle"}])
    first = categories.list_categories()
    first[0]["bucket"] = "changed"
    assert categories.list_categories() == [{"id": "coffee", "bucket": "Lifestyle"}]
    assert categories.list_calls == 2

    down = RuntimeError("down")
    failing = _FakeCategoryRepo(error=down)
    with pytest.raises(RuntimeError) as raised:
        failing.list_categories()
    assert raised.value is down

    assert _spend_cat() == [{"id": "insurance", "bucket": "Living", "parent": None}]
    assert _spend_cat("rent", bucket="Bills") == [{"id": "rent", "bucket": "Bills", "parent": None}]

    taxonomy = FakeCategoryRepo(["groceries"])
    assert taxonomy.list_calls == 0
    assert taxonomy.list_categories() == [{"id": "groceries"}]
    assert taxonomy.list_calls == 1

    boom = RuntimeError("taxonomy read boom")
    with pytest.raises(RuntimeError) as raised:
        FakeCategoryRepo(["groceries"], error=boom).list_categories()
    assert raised.value is boom

