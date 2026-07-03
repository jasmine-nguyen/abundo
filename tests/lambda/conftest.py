"""Test bootstrap for the BankSync webhook lambda suite (``lambda/``).

``lambda/`` owns only the webhook-specific ``handler`` / ``repository`` /
``banksync`` (and imports ``ssm`` / ``standardwebhooks``); ``constants`` /
``models`` / ``encoders`` come from the shared layer (``shared/``), exactly as the
deployed webhook resolves them (its function code shadows the attached layer). The
``lam`` fixture therefore pins ``lambda/`` in front of ``shared/`` on ``sys.path``
— so ``lambda/``'s own copies win and the folded modules fall through to
``shared/``, mirroring ``/var/task`` before ``/opt/python`` in prod — sheds the
colliding bare names from ``sys.modules`` before importing, and restores
everything afterwards.

Unlike the lambda_api fakes (which set ``Key = Attr = object`` because those tests
never query), this suite exercises ``get_pending_transactions_for_account``, so it
installs condition-recording ``Key``/``Attr`` (``_Field``) that ``FakeTable`` can
actually evaluate against a stored item.
"""

import pathlib
import sys
import types

import pytest


class _Predicate:
    """A boto3 condition stand-in a fake table can evaluate against an item."""

    def __init__(self, fn):
        self._fn = fn

    def evaluate(self, item) -> bool:
        return self._fn(item)

    def __and__(self, other):
        return _Predicate(lambda item: self._fn(item) and other.evaluate(item))


class _Field:
    """Fake boto3 Key/Attr: ``_Field(name).eq(v)`` / ``.between(lo, hi)`` → _Predicate."""

    def __init__(self, name):
        self._name = name

    def eq(self, value):
        name = self._name
        return _Predicate(lambda item: item.get(name) == value)

    def between(self, lo, hi):
        name = self._name
        return _Predicate(lambda item: lo <= item.get(name, "") <= hi)


def _ensure_boto3_botocore():
    if "boto3" not in sys.modules:
        boto3 = types.ModuleType("boto3")
        boto3.resource = lambda *a, **k: None  # never called: tests inject repo._table
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


def _fake_import_satisfiers() -> dict:
    """Fake ``ssm`` + ``standardwebhooks`` so ``handler.py`` imports without AWS."""
    ssm = types.ModuleType("ssm")
    ssm.get_param = lambda *a, **k: "fake-secret"

    standardwebhooks = types.ModuleType("standardwebhooks")
    webhooks = types.ModuleType("standardwebhooks.webhooks")

    class Webhook:
        def __init__(self, *a, **k):
            pass

        def verify(self, *a, **k):
            return {}

    webhooks.Webhook = Webhook
    standardwebhooks.webhooks = webhooks
    return {
        "ssm": ssm,
        "standardwebhooks": standardwebhooks,
        "standardwebhooks.webhooks": webhooks,
    }


_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_LAMBDA_DIR = str(_REPO_ROOT / "lambda")
_SHARED_DIR = str(_REPO_ROOT / "shared")
# Bare module names whose imports must resolve fresh per test: lambda/'s own copies
# (handler / repository / banksync) plus the folded modules now provided by shared/
# (constants / models / encoders). Shed so a sibling suite's cached copy can't win.
_REIMPORT = ("handler", "constants", "models", "repository", "banksync", "encoders", "merchant")


@pytest.fixture
def lam():
    """Import the webhook lambda's modules in isolation; yield the ones tests use."""
    _ensure_boto3_botocore()
    conds = sys.modules["boto3.dynamodb.conditions"]
    saved_key = getattr(conds, "Key", None)
    saved_attr = getattr(conds, "Attr", None)
    conds.Key = _Field
    conds.Attr = _Field

    saved_fakes = {}
    for name, mod in _fake_import_satisfiers().items():
        saved_fakes[name] = sys.modules.get(name)
        sys.modules[name] = mod

    for d in (_LAMBDA_DIR, _SHARED_DIR):
        while d in sys.path:
            sys.path.remove(d)
    # shared/ first, then lambda/ on top: lambda/ wins for its own modules, and the
    # folded ones (constants / models / encoders) fall through to shared/.
    sys.path.insert(0, _SHARED_DIR)
    sys.path.insert(0, _LAMBDA_DIR)
    saved_real = {name: sys.modules.pop(name, None) for name in _REIMPORT}

    import banksync
    import handler
    import merchant
    import models
    import repository

    ns = types.SimpleNamespace(
        repository=repository, banksync=banksync, handler=handler, models=models,
        merchant=merchant,
    )
    try:
        yield ns
    finally:
        for name in _REIMPORT:
            sys.modules.pop(name, None)
            if saved_real[name] is not None:
                sys.modules[name] = saved_real[name]
        for name, orig in saved_fakes.items():
            if orig is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = orig
        conds.Key = saved_key
        conds.Attr = saved_attr
        for d in (_LAMBDA_DIR, _SHARED_DIR):
            while d in sys.path:
                sys.path.remove(d)


class FakeTable:
    """In-memory DynamoDB table stand-in, injected via ``repo._table``. Emulates the
    calls the webhook repository makes: get_item, batch_writer put, delete_item, and
    query with KeyConditionExpression + FilterExpression (evaluated via _Predicate).
    """

    def __init__(self):
        self.store: dict = {}  # (pk, sk) -> item
        self.query_calls = 0

    def get_item(self, Key):
        item = self.store.get((Key["pk"], Key["sk"]))
        return {"Item": dict(item)} if item is not None else {}

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
        self.store[(Item["pk"], Item["sk"])] = dict(Item)

    def delete_item(self, Key, ConditionExpression=None):
        # No attribute_exists guard here → deleting a missing key is a no-op,
        # matching _delete_pending_if_present's tolerant delete.
        self.store.pop((Key["pk"], Key["sk"]), None)

    def query(self, KeyConditionExpression=None, FilterExpression=None,
              ScanIndexForward=None, Limit=None, IndexName=None):
        self.query_calls += 1
        items = list(self.store.values())
        if KeyConditionExpression is not None:
            items = [it for it in items if KeyConditionExpression.evaluate(it)]
        if FilterExpression is not None:
            items = [it for it in items if FilterExpression.evaluate(it)]
        return {"Items": [dict(it) for it in items]}


@pytest.fixture
def repo(lam):
    """A webhook TransactionRepository backed by an in-memory FakeTable."""
    r = lam.repository.TransactionRepository()
    r._table = FakeTable()
    return r
