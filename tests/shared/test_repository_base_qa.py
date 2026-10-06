"""QA edges for RepositoryBase (WHIT-763 slice 1): the shared connect step, the shared
'read every page' loop's failure paths."""

import types

import pytest

from _dynamo_fakes import FakeTable, _client_error


def _base_repo(table):
    import repository_base

    repo = repository_base.RepositoryBase()
    repo._table = table
    return repo


# [A1] (P0)
def test_get_table_connects_once_per_instance_to_the_configured_table(shared, monkeypatch):
    import repository_base

    resource_calls = []

    def fake_resource(service, region_name):
        resource_calls.append((service, region_name))
        return types.SimpleNamespace(Table=lambda name: types.SimpleNamespace(name=name))

    monkeypatch.setattr(repository_base, "boto3", types.SimpleNamespace(resource=fake_resource))

    repo = repository_base.RepositoryBase()
    table = repo._get_table()
    assert repo._get_table() is table
    assert table.name == repository_base.TABLE_NAME
    assert resource_calls == [("dynamodb", repository_base.REGION_NAME)]


# [A2] (P0)
def test_paginated_query_maps_a_client_error_to_database_error_with_its_action(shared, database_error):
    from boto3.dynamodb.conditions import Key

    table = FakeTable()
    table.fail("query", _client_error("InternalServerError", "kaboom"))
    repo = _base_repo(table)

    with pytest.raises(database_error, match="^Database list widgets failed: kaboom$"):
        repo._paginated_query(key_condition=Key("pk").eq("P"), action="list widgets")
    with pytest.raises(database_error, match="^Database read failed: kaboom$"):
        repo._paginated_query(key_condition=Key("pk").eq("P"))


# [A3] (P1)
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


# [A6] (P0)
def test_list_rules_reads_only_the_rule_partition_and_reports_failures_as_list_rules(
        rule_repo, database_error):
    rule_repo._table.seed(
        *({"pk": "RULE", "sk": f"RULE#{number}", "id": str(number)} for number in range(5)),
        {"pk": "JOB", "sk": "JOB#1", "id": "job"},
    )
    rule_repo._table.page_size = 2

    assert sorted(rule["id"] for rule in rule_repo.list_rules()) == ["0", "1", "2", "3", "4"]
    assert len(rule_repo._table.queries) == 3

    rule_repo._table.fail("query", _client_error("InternalServerError", "down"))
    with pytest.raises(database_error, match="^Database list rules failed: down$"):
        rule_repo.list_rules()


# [A7] (P1)
def test_list_pending_skips_a_malformed_row_on_a_later_page_and_labels_failures(shared, database_error):
    repo = shared.push_receipt.PushReceiptRepository()
    repo._table = FakeTable()
    repo._table.page_size = 1
    repo._table.seed(
        {"pk": "PUSHRECEIPT#PENDING", "sk": "r1", "token": "t1"},
        {"pk": "PUSHRECEIPT#PENDING", "sk": "r2"},
        {"pk": "PUSHRECEIPT#PENDING", "sk": "r3", "token": "t3"},
    )
    assert repo.list_pending() == [("r1", "t1"), ("r3", "t3")]

    table = FakeTable()
    table.fail("query", _client_error("InternalServerError", "down"))
    repo._table = table
    with pytest.raises(database_error, match="^Database list pending push receipts failed: down$"):
        repo.list_pending()
