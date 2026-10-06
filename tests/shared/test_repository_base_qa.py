"""QA edges for RepositoryBase (WHIT-763 slice 1): the shared connect step, the shared
'read every page' loop's failure paths, and the trimmed repository.py facade."""

import ast
import importlib
import pathlib
import types

import pytest

from _dynamo_fakes import FakeTable, _client_error
from test_repository_base import _REPOSITORY_CLASSES

_ROOT = pathlib.Path(__file__).resolve().parents[2]
_FACADE_CALLERS = [
    "lambda_api/handler.py",
    "lambda_api/apply_rules_worker.py",
    "lambda_api/ai_chat.py",
    "lambda_balance_poller/handler.py",
    "lambda_goal_nudge/handler.py",
]


def _base_repo(table):
    import repository_base

    repo = repository_base.RepositoryBase()
    repo._table = table
    return repo


class _PagedTable:
    """Serves preset ``(items_or_None, last_key)`` pages; a None items list omits "Items"."""

    def __init__(self, pages):
        self._pages = pages
        self.calls = []

    def query(self, **kwargs):
        items, last_key = self._pages[len(self.calls)]
        self.calls.append(kwargs)
        response = {}
        if items is not None:
            response["Items"] = items
        if last_key is not None:
            response["LastEvaluatedKey"] = last_key
        return response


# [A1] (P0)
def test_every_database_class_connects_once_per_instance_to_the_configured_table(shared, monkeypatch):
    import repository_base

    resource_calls = []

    class _Resource:
        def Table(self, name):
            return types.SimpleNamespace(name=name)

    def fake_resource(service, region_name):
        resource_calls.append((service, region_name))
        return _Resource()

    monkeypatch.setattr(repository_base, "boto3", types.SimpleNamespace(resource=fake_resource))

    for module_name, class_name in _REPOSITORY_CLASSES:
        cls = getattr(importlib.import_module(module_name), class_name)
        resource_calls.clear()
        first, second = cls(), cls()
        table = first._get_table()
        assert first._get_table() is table, class_name
        assert table.name == repository_base.TABLE_NAME, class_name
        assert resource_calls == [("dynamodb", repository_base.REGION_NAME)], class_name
        assert second._table is None, f"{class_name} shares its table across instances"
        assert second._get_table() is not table, class_name


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


# [A4] (P1)
def test_paginated_query_threads_each_page_cursor_into_the_next_query(shared):
    table = _PagedTable([
        ([{"sk": "a"}], {"pk": "P", "sk": "a"}),
        ([{"sk": "b"}], {"pk": "P", "sk": "b"}),
        ([{"sk": "c"}], None),
    ])
    repo = _base_repo(table)

    items = repo._paginated_query(key_condition="KEY")

    assert [item["sk"] for item in items] == ["a", "b", "c"]
    assert "ExclusiveStartKey" not in table.calls[0]
    assert table.calls[1]["ExclusiveStartKey"] == {"pk": "P", "sk": "a"}
    assert table.calls[2]["ExclusiveStartKey"] == {"pk": "P", "sk": "b"}
    assert all(call["KeyConditionExpression"] == "KEY" for call in table.calls)


# [A5] (P2)
def test_paginated_query_tolerates_a_page_with_no_items_key(shared):
    table = _PagedTable([(None, {"pk": "P", "sk": "x"}), ([{"sk": "y"}], None)])
    repo = _base_repo(table)

    assert repo._paginated_query(key_condition="KEY") == [{"sk": "y"}]


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
    repo._table = _PagedTable([
        ([{"sk": "r1", "token": "t1"}], {"pk": "PUSHRECEIPT#PENDING", "sk": "r1"}),
        ([{"sk": "r2"}, {"sk": "r3", "token": "t3"}], None),
    ])
    assert repo.list_pending() == [("r1", "t1"), ("r3", "t3")]

    table = FakeTable()
    table.fail("query", _client_error("InternalServerError", "down"))
    repo._table = table
    with pytest.raises(database_error, match="^Database list pending push receipts failed: down$"):
        repo.list_pending()


# [A8] (P0)
def test_facade_hands_out_only_classes_and_error_types(shared):
    import repository
    import repository_base
    import repository_errors

    for name in repository.__all__:
        exported = getattr(repository, name)
        assert isinstance(exported, type), f"repository.py still re-exports helper {name}"
        is_repo = issubclass(exported, repository_base.RepositoryBase)
        is_error = exported.__module__ == repository_errors.__name__
        assert is_repo or is_error, f"repository.py exports {name}, neither a repository nor an error"
    for removed in ("handle_database_error", "sanitise_transaction", "SEED_CATEGORIES",
                    "CATEGORY_PALETTE", "validate_category_parent", "plan_color_slot_stage"):
        assert not hasattr(repository, removed), f"repository.py still re-exports {removed}"


# [A9] (P0)
@pytest.mark.parametrize("caller", _FACADE_CALLERS)
def test_every_production_facade_import_still_resolves(shared, caller):
    import repository

    tree = ast.parse((_ROOT / caller).read_text())
    imported = [
        alias.name
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom) and node.module == "repository"
        for alias in node.names
    ]
    assert imported, f"{caller} no longer imports from repository"
    for name in imported:
        assert name in repository.__all__ and hasattr(repository, name), f"{caller} imports {name}"
