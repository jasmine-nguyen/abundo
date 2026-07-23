"""Test bootstrap for the balance-poller Lambda suite.

Like the lambda_api suite, importing ``lambda_balance_poller/handler.py`` in a
test is non-trivial: it imports ``repository`` (which at load reads
``AWS_REGION``/``TABLE_NAME`` and imports ``boto3``/``botocore``) and ``ssm``
(which imports ``boto3``). None of that AWS wiring is needed to unit-test the
normaliser / request shape / failure isolation, so we set the env vars and
register lightweight fakes before the first import. Handler tests replace the
repository (monkeypatching ``handler.HomeLoanBalanceRepository``), so the fakes
are never exercised — they only satisfy the import chain.

``handler``/``constants``/``repository`` collide with the sibling lambda suites,
so the ``handler`` fixture sheds those names, pins this package's dirs to the
front of sys.path, imports, then restores — the same isolation the lambda_api
conftest uses.
"""

import os
import pathlib
import sys
import types

import pytest

# Env vars repository_base.py reads at import time.
os.environ.setdefault("AWS_REGION", "ap-southeast-2")
os.environ.setdefault("TABLE_NAME", "test-table")

# Fake boto3 / botocore so importing the shared repository needs no AWS deps.
if "boto3" not in sys.modules:
    _boto3 = types.ModuleType("boto3")
    _conditions = types.ModuleType("boto3.dynamodb.conditions")
    _conditions.Attr = object
    _conditions.Key = object
    _dynamodb = types.ModuleType("boto3.dynamodb")
    _dynamodb.conditions = _conditions
    _boto3.dynamodb = _dynamodb
    sys.modules.update({
        "boto3": _boto3,
        "boto3.dynamodb": _dynamodb,
        "boto3.dynamodb.conditions": _conditions,
    })

if "botocore" not in sys.modules:
    _botocore = types.ModuleType("botocore")
    _exceptions = types.ModuleType("botocore.exceptions")

    class ClientError(Exception):
        pass

    _exceptions.ClientError = ClientError
    _botocore.exceptions = _exceptions
    sys.modules.update({"botocore": _botocore, "botocore.exceptions": _exceptions})

# Fake `ssm` so `from ssm import get_param` succeeds without boto3/AWS. Tests that
# care about SSM monkeypatch handler.get_param / handler._api_key directly.
if "ssm" not in sys.modules:
    _ssm = types.ModuleType("ssm")
    _ssm.get_param = lambda parameter_name: "test-api-key"
    sys.modules["ssm"] = _ssm

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_POLLER_DIR = str(_REPO_ROOT / "lambda_balance_poller")
_SHARED_DIR = str(_REPO_ROOT / "shared")
# Names that collide with the sibling suites (lambda/lambda_api/sync_trigger),
# re-imported fresh per test so this package's copies win.
_COLLIDING = (
    "handler", "constants", "models", "encoders", "repository", "repository_base",
    "repository_transaction", "repository_category", "repository_budget",
    "repository_paycycle", "repository_balance", "repayment_rules",
)


@pytest.fixture
def handler():
    """Import lambda_balance_poller/handler.py in isolation and hand it to the test."""
    for d in (_SHARED_DIR, _POLLER_DIR):
        while d in sys.path:
            sys.path.remove(d)
    # poller dir first so its handler wins; repository resolves in shared.
    sys.path.insert(0, _SHARED_DIR)
    sys.path.insert(0, _POLLER_DIR)

    saved = {name: sys.modules.pop(name, None) for name in _COLLIDING}
    import handler as h

    h._api_key = None  # never leak a cached key across tests
    try:
        yield h
    finally:
        for name in _COLLIDING:
            sys.modules.pop(name, None)
        for name, mod in saved.items():
            if mod is not None:
                sys.modules[name] = mod
