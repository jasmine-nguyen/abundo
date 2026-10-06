"""Backstage setup for the sync-trigger Lambda tests.

pytest loads this file automatically before running any test in this directory.
Its first job is to make ``lambda_sync_trigger/handler.py`` *importable in a test
process*, which is not trivial because the handler imports two modules that only
exist inside the deployed Lambda layer:

    from constants import (...)   # real -> shared/constants.py
    from ssm import get_param     # shared/ssm.py, which imports boto3

We do two things, once, at collection time (before the handler is imported):

1. Put ``shared/`` and ``lambda_sync_trigger/`` on sys.path so ``import
   constants`` and ``import handler`` resolve the same way they do in the layer.
2. Install the shared fakes: a fake ``ssm`` module so importing the handler does
   NOT drag in boto3 (the real ssm.get_param talks to AWS; tests never want that),
   plus AWS_REGION / TABLE_NAME and a fake boto3 for the repositories the pending
   mirror (WHIT-662) imports.

This must be plain module-level code (not a fixture): the handler's top-level
imports run during collection, before any fixture body executes, so a fixture
would be too late. Everything *runtime* (mocking urlopen, resetting the api-key
cache) is done per-test with monkeypatch in test_handler.py.

Its second job (WHIT-784) is the pending-mirror fixtures every mirror suite shares:
``layer`` / ``repo`` / ``mirror`` / ``pending_carry`` / ``row``. Their plain helpers and
constants live in tests/shared/_pending_mirror_fakes.py.
"""

import importlib
import pathlib
import sys
from decimal import Decimal

import pytest

from _boto_stubs import install_import_satisfiers, use_condition_fields
from _dynamo_fakes import FakeTable
from _pending_mirror_fakes import WESTPAC

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]

# 1. Make the layer-provided modules and the handler importable.
sys.path.insert(0, str(_REPO_ROOT / "shared"))
sys.path.insert(0, str(_REPO_ROOT / "lambda_sync_trigger"))

# 2. Shared fakes (see docstring).
install_import_satisfiers()

_SHARED_DIR = str(_REPO_ROOT / "shared")
_SHARED_MODULES = {path.stem for path in pathlib.Path(_SHARED_DIR).glob("*.py")} - {"ssm"}


@pytest.fixture
def layer():
    """(repository_transaction, pending_mirror), freshly imported over the condition-recording
    boto fakes so FakeTable can evaluate their queries and conditional deletes."""
    with use_condition_fields():
        sys.path.insert(0, _SHARED_DIR)
        saved = {name: sys.modules.pop(name, None) for name in _SHARED_MODULES | {"pending_mirror"}}
        try:
            yield importlib.import_module("repository_transaction"), importlib.import_module("pending_mirror")
        finally:
            for name, module in saved.items():
                sys.modules.pop(name, None)
                if module is not None:
                    sys.modules[name] = module
            sys.path.remove(_SHARED_DIR)


@pytest.fixture
def repo(layer):
    repository = layer[0].TransactionRepository()
    repository._table = FakeTable()
    return repository


@pytest.fixture
def mirror(layer):
    return layer[1]


@pytest.fixture
def pending_carry(layer):
    return importlib.import_module("pending_carry")


@pytest.fixture
def row(layer):
    """A Westpac charge with its merchant cleaned from the description, as the webhook stores it."""
    clean_merchant = importlib.import_module("merchant").clean_merchant

    def make(transaction_id, description, amount, day="2026-09-30", status="pending", **fields):
        return {
            "pk": f"ACCOUNT#{WESTPAC}",
            "sk": f"TXN#{transaction_id}",
            "transaction_id": transaction_id,
            "account_id": WESTPAC,
            "date": day,
            "amount": Decimal(amount),
            "description": description,
            "merchant_name": clean_merchant(description, ""),
            "status": status,
            "category": "Unfiled",
            **fields,
        }
    return make
