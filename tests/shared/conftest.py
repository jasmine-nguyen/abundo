"""Test bootstrap for the ``shared/`` layer suite.

``shared/`` holds the flat top-level modules that the deployed Lambda layer
provides: ``constants`` / ``models`` / ``encoders`` / ``repository_base`` /
``repository_transaction`` (and the other repository_* files). Their bare module
names collide with the ``lambda`` / ``lambda_api`` / ``sync_trigger`` suites, so —
mirroring ``tests/lambda/conftest.py`` — the fixtures below pin ``shared/`` to the
front of ``sys.path``, shed those names from ``sys.modules`` before importing so
``shared/``'s copies win, and restore everything afterwards.

``repository_base`` reads ``os.environ["AWS_REGION"]`` / ``["TABLE_NAME"]`` and
imports ``boto3`` / ``botocore`` at load, none of which is needed to unit-test the
repository logic. We set the env vars and register lightweight fake boto3/botocore
modules up front; the ``repo`` fixture injects an in-memory ``FakeTable`` so the
fake ``boto3.resource`` is never exercised. The fake ``Key``/``Attr`` (``_Field``)
record conditions that ``FakeTable`` can evaluate against a stored item.
"""

import os
import pathlib
import sys
import types

import pytest

# Env vars repository_base.py reads at import time.
os.environ.setdefault("AWS_REGION", "ap-southeast-2")
os.environ.setdefault("TABLE_NAME", "test-table")


class _Predicate:
    """A boto3 condition stand-in a fake table can evaluate against an item."""

    def __init__(self, fn):
        self._fn = fn

    def evaluate(self, item) -> bool:
        return self._fn(item)

    def __and__(self, other):
        return _Predicate(lambda item: self._fn(item) and other.evaluate(item))


class _Field:
    """Fake boto3 Key/Attr: ``_Field(name).eq(v)`` / ``.between`` / ``.gte`` → _Predicate."""

    def __init__(self, name):
        self._name = name

    def eq(self, value):
        name = self._name
        return _Predicate(lambda item: item.get(name) == value)

    def gte(self, lo):
        name = self._name
        return _Predicate(lambda item: item.get(name, "") >= lo)

    def between(self, lo, hi):
        name = self._name
        return _Predicate(lambda item: lo <= item.get(name, "") <= hi)


def _ensure_boto3_botocore():
    if "boto3" not in sys.modules:
        boto3 = types.ModuleType("boto3")
        boto3.resource = lambda *a, **k: None  # never called: repo._table is injected
        conditions = types.ModuleType("boto3.dynamodb.conditions")
        dynamodb = types.ModuleType("boto3.dynamodb")
        dynamodb.conditions = conditions
        boto3.dynamodb = dynamodb
        sys.modules.update({
            "boto3": boto3,
            "boto3.dynamodb": dynamodb,
            "boto3.dynamodb.conditions": conditions,
        })
    if "botocore" not in sys.modules:
        botocore = types.ModuleType("botocore")
        exceptions = types.ModuleType("botocore.exceptions")

        class ClientError(Exception):
            pass

        exceptions.ClientError = ClientError
        botocore.exceptions = exceptions
        sys.modules.update({"botocore": botocore, "botocore.exceptions": exceptions})


_SHARED_DIR = str(pathlib.Path(__file__).resolve().parents[2] / "shared")
# shared/ modules whose bare names collide with the sibling suites.
_REIMPORT = (
    "constants", "models", "encoders", "repository_base", "repository_transaction",
    "repository_balance", "repository_loanfacts", "repository_budget",
    "repository_errors", "repository_insight", "repository_device", "push",
    "repository_push_receipt", "repository_notify", "spend", "budget_alerts",
)


@pytest.fixture
def shared():
    """Import the shared layer's modules in isolation; yield the ones tests use."""
    _ensure_boto3_botocore()
    conds = sys.modules["boto3.dynamodb.conditions"]
    saved_key = getattr(conds, "Key", None)
    saved_attr = getattr(conds, "Attr", None)
    conds.Key = _Field
    conds.Attr = _Field

    while _SHARED_DIR in sys.path:
        sys.path.remove(_SHARED_DIR)
    sys.path.insert(0, _SHARED_DIR)
    saved_real = {name: sys.modules.pop(name, None) for name in _REIMPORT}

    import encoders
    import repository_transaction
    import repository_balance
    import repository_loanfacts
    import repository_budget
    import repository_insight
    import repository_device
    import push
    import repository_push_receipt
    import repository_notify
    import spend

    ns = types.SimpleNamespace(
        encoders=encoders, repository=repository_transaction,
        balance=repository_balance, loanfacts=repository_loanfacts,
        budget=repository_budget, insight=repository_insight,
        device=repository_device, push=push, push_receipt=repository_push_receipt,
        notify=repository_notify, spend=spend,
    )
    try:
        yield ns
    finally:
        for name in _REIMPORT:
            sys.modules.pop(name, None)
            if saved_real[name] is not None:
                sys.modules[name] = saved_real[name]
        conds.Key = saved_key
        conds.Attr = saved_attr
        while _SHARED_DIR in sys.path:
            sys.path.remove(_SHARED_DIR)


def _client_error(code: str, message: str = "boom"):
    """Build a botocore-shaped ClientError the repository's handlers can inspect."""
    err = sys.modules["botocore.exceptions"].ClientError()
    err.response = {"Error": {"Code": code, "Message": message}}
    return err


@pytest.fixture
def database_error(shared):
    """The DatabaseError type handle_database_error raises (WHIT-127). Depends on
    `shared` so shared/ is on sys.path and this resolves the same class the repos do."""
    import repository_errors
    return repository_errors.DatabaseError


class FakeTable:
    """In-memory DynamoDB table stand-in, injected via ``repo._table``. Emulates the
    calls the shared TransactionRepository makes: batch_writer put, conditional
    put_item / update_item, and query with KeyConditionExpression + FilterExpression
    (evaluated via _Predicate), newest-first ordering, Limit and cursor pagination.
    """

    def __init__(self):
        self.store: dict = {}  # (pk, sk) -> item
        self.query_calls = 0

    def batch_writer(self):
        store = self.store

        class _Batch:
            def __enter__(self_):
                return self_

            def __exit__(self_, *exc):
                return False

            def put_item(self_, Item):
                store[(Item["pk"], Item["sk"])] = dict(Item)

        return _Batch()

    def put_item(self, Item, ConditionExpression=None):
        key = (Item["pk"], Item["sk"])
        if ConditionExpression == "attribute_not_exists(pk)" and key in self.store:
            raise _client_error("ConditionalCheckFailedException")
        self.store[key] = dict(Item)

    def get_item(self, Key):
        item = self.store.get((Key["pk"], Key["sk"]))
        return {"Item": dict(item)} if item is not None else {}

    def update_item(self, Key, UpdateExpression, ExpressionAttributeNames,
                    ExpressionAttributeValues, ConditionExpression=None):
        key = (Key["pk"], Key["sk"])
        if ConditionExpression == "attribute_exists(pk)" and key not in self.store:
            raise _client_error("ConditionalCheckFailedException")
        item = self.store.setdefault(key, {"pk": Key["pk"], "sk": Key["sk"]})
        # Parse the "SET #a = :x, #b = :y" clause the repository builds.
        assignments = UpdateExpression[len("SET "):].split(",")
        for pair in assignments:
            name_alias, value_alias = (part.strip() for part in pair.split("="))
            attr = ExpressionAttributeNames[name_alias]
            item[attr] = ExpressionAttributeValues[value_alias]

    def query(self, KeyConditionExpression=None, FilterExpression=None,
              ScanIndexForward=None, Limit=None, IndexName=None,
              ExclusiveStartKey=None):
        self.query_calls += 1
        items = list(self.store.values())
        if KeyConditionExpression is not None:
            items = [it for it in items if KeyConditionExpression.evaluate(it)]
        if FilterExpression is not None:
            items = [it for it in items if FilterExpression.evaluate(it)]

        # date-index reads sort by date; ScanIndexForward=False → newest first.
        items.sort(
            key=lambda it: (it.get("date", ""), it.get("sk", "")),
            reverse=ScanIndexForward is False,
        )

        if ExclusiveStartKey is not None:
            after = (ExclusiveStartKey["pk"], ExclusiveStartKey["sk"])
            for i, it in enumerate(items):
                if (it["pk"], it["sk"]) == after:
                    items = items[i + 1:]
                    break

        result: dict = {}
        if Limit is not None and len(items) > Limit:
            page = items[:Limit]
            last = page[-1]
            result["LastEvaluatedKey"] = {"pk": last["pk"], "sk": last["sk"]}
        else:
            page = items
        result["Items"] = [dict(it) for it in page]
        return result


@pytest.fixture
def repo(shared):
    """A shared TransactionRepository backed by an in-memory FakeTable."""
    r = shared.repository.TransactionRepository()
    r._table = FakeTable()
    return r


@pytest.fixture
def balance_repo(shared):
    """A shared HomeLoanBalanceRepository backed by an in-memory FakeTable."""
    r = shared.balance.HomeLoanBalanceRepository()
    r._table = FakeTable()
    return r


@pytest.fixture
def account_balance_repo(shared):
    """A shared AccountBalanceRepository backed by an in-memory FakeTable."""
    r = shared.balance.AccountBalanceRepository()
    r._table = FakeTable()
    return r


@pytest.fixture
def insight_repo(shared):
    """A shared InsightRepository backed by an in-memory FakeTable."""
    r = shared.insight.InsightRepository()
    r._table = FakeTable()
    return r


@pytest.fixture
def loanfacts_repo(shared):
    """A shared LoanFactsRepository backed by an in-memory FakeTable."""
    r = shared.loanfacts.LoanFactsRepository()
    r._table = FakeTable()
    return r


@pytest.fixture
def client_error():
    """Factory for a botocore-shaped ClientError, for driving the error paths."""
    return _client_error
