"""RepositoryBase (shared/repository_base.py) — the one shared starting point for every database
class (WHIT-763): the 'read every page' loop, the conditional save and the seed-on-first-read."""

import importlib
from decimal import Decimal

import pytest

from _dynamo_fakes import FakeTable


def test_paginated_query_reads_every_page_and_sends_no_filter_when_none_given(shared):
    import repository_base
    from boto3.dynamodb.conditions import Attr, Key

    class _Repo(repository_base.RepositoryBase):
        pass

    repo = _Repo()
    table = FakeTable()
    table.page_size = 2
    table.seed(
        {"pk": "P", "sk": "1", "status": "keep"},
        {"pk": "P", "sk": "2", "status": "drop"},
        {"pk": "P", "sk": "3", "status": "drop"},
        {"pk": "P", "sk": "4", "status": "keep"},
        {"pk": "P", "sk": "5", "status": "keep"},
        {"pk": "OTHER", "sk": "9", "status": "keep"},
    )
    repo._table = table

    every_row = repo._paginated_query(key_condition=Key("pk").eq("P"))
    assert [item["sk"] for item in every_row] == ["1", "2", "3", "4", "5"]
    assert len(table.queries) == 3
    assert all("FilterExpression" not in query for query in table.queries)

    table.queries.clear()
    kept = repo._paginated_query(
        key_condition=Key("pk").eq("P"), filter_expression=Attr("status").eq("keep"),
    )
    assert [item["sk"] for item in kept] == ["1", "4", "5"]
    assert all("FilterExpression" in query for query in table.queries)


@pytest.mark.parametrize(
    "raised, expected",
    [
        (None, True),
        ("ConditionalCheckFailedException", False),
    ],
)
def test_conditional_write_says_whether_the_save_landed(shared, client_error, raised, expected):
    import repository_base

    writes = []

    def write():
        writes.append("tried")
        if raised:
            raise client_error(raised)

    assert repository_base.conditional_write("claim budget-alert marker", write) is expected
    assert writes == ["tried"]


def test_conditional_write_turns_any_other_client_error_into_a_database_error_naming_the_action(
    shared, client_error, database_error,
):
    import repository_base

    def write():
        raise client_error("InternalServerError", "down")

    with pytest.raises(database_error, match="Database claim budget-alert marker failed: down"):
        repository_base.conditional_write("claim budget-alert marker", write)


def _base_repo(table):
    import repository_base

    repo = repository_base.RepositoryBase()
    repo._table = table
    return repo


def test_paginated_query_failing_on_a_later_page_raises_instead_of_returning_a_partial_list(
        shared, database_error):
    from boto3.dynamodb.conditions import Key

    table = FakeTable()
    table.page_size = 1
    table.seed({"pk": "P", "sk": "1"}, {"pk": "P", "sk": "2"})
    table.fail("query", when=lambda kwargs: "ExclusiveStartKey" in kwargs)
    repo = _base_repo(table)

    with pytest.raises(database_error):
        repo._paginated_query(key_condition=Key("pk").eq("P"))


# (module, class, read, racer's extra fields, what the read must return)
_SEEDED_READS = [
    ("repository_budget", "BudgetRepository", lambda r: r.list_budgets(),
     {"items": {"food": {"target": Decimal(50)}}}, {"food": {"target": Decimal(50)}}),
    ("repository_goals", "GoalsRepository", lambda r: r.list_goals(),
     {"items": {"g1": {"name": "Trip"}}}, {"g1": {"name": "Trip"}}),
    ("repository_paycycle", "PayCycleRepository", lambda r: r.get_paycycle(),
     {"length": Decimal(7), "last_pay_date": "2026-09-30"}, {"length": 7, "last_pay_date": "2026-09-30"}),
]


@pytest.mark.parametrize("module_name, class_name, read, racer_fields, expected", _SEEDED_READS,
                         ids=[row[1] for row in _SEEDED_READS])
def test_first_read_that_loses_the_seed_race_returns_the_winners_record(
        shared, module_name, class_name, read, racer_fields, expected):
    store = getattr(importlib.import_module(module_name), class_name)()
    table = FakeTable()
    store._table = table
    racer = {**store._config_key, **racer_fields, "version": Decimal(2)}
    real_put = table.put_item

    def put_after_the_racer(**kwargs):
        table.seed(racer)   # another caller seeded between our read and our seed
        return real_put(**kwargs)

    table.put_item = put_after_the_racer

    assert read(store) == expected
    assert table.store[(racer["pk"], racer["sk"])]["version"] == Decimal(2)
