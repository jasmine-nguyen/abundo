"""RepositoryBase (shared/repository_base.py) — the one shared starting point for every database
class (WHIT-763): the lazy table connect and the 'read every page' loop."""

import importlib

from _dynamo_fakes import FakeTable

# (module, class) for all 16 database classes.
_REPOSITORY_CLASSES = [
    ("repository_balance", "HomeLoanBalanceRepository"),
    ("repository_balance", "AccountBalanceRepository"),
    ("repository_balance", "FeedWatchRepository"),
    ("repository_budget", "BudgetRepository"),
    ("repository_category", "CategoryRepository"),
    ("repository_device", "DeviceRepository"),
    ("repository_goals", "GoalsRepository"),
    ("repository_insight", "InsightRepository"),
    ("repository_job", "JobRepository"),
    ("repository_loanfacts", "LoanFactsRepository"),
    ("repository_milestone", "MilestoneRepository"),
    ("repository_notify", "NotifyRepository"),
    ("repository_paycycle", "PayCycleRepository"),
    ("repository_push_receipt", "PushReceiptRepository"),
    ("repository_rule", "RuleRepository"),
    ("repository_transaction", "TransactionRepository"),
]


def test_every_database_class_builds_on_the_shared_base(shared):
    import repository_base

    for module_name, class_name in _REPOSITORY_CLASSES:
        cls = getattr(importlib.import_module(module_name), class_name)
        assert issubclass(cls, repository_base.RepositoryBase), class_name
        assert "__init__" not in vars(cls), f"{class_name} still has its own __init__"
        assert "_get_table" not in vars(cls), f"{class_name} still has its own _get_table"
        repo = cls()
        assert repo._table is None and repo._dynamodb is None, class_name


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
