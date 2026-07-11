"""Test bootstrap for the goal-nudge Lambda suite.

Like the balance-poller suite, importing ``lambda_goal_nudge/handler.py`` pulls in
``repository`` (which at load reads ``AWS_REGION``/``TABLE_NAME`` and imports
``boto3``/``botocore``), ``goal_nudge`` (which imports ``push``/``spend``), and
``repository_notify``. None of that AWS wiring is needed to unit-test the handler's
wiring + failure isolation, so we set the env vars and register lightweight fakes before
the first import. Handler tests monkeypatch ``handler.notify_behind_goals`` directly, so the
fakes only satisfy the import chain.

``handler``/``constants``/``repository`` collide with the sibling lambda suites, so the
``handler`` fixture sheds those names, pins this package's dirs to the front of sys.path,
imports, then restores — the same isolation the balance_poller conftest uses.
"""

import os
import pathlib
import sys
import types

import pytest

os.environ.setdefault("AWS_REGION", "ap-southeast-2")
os.environ.setdefault("TABLE_NAME", "test-table")

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

# Fake `ssm` so any `from ssm import get_param` in the import chain (push) succeeds
# without boto3/AWS.
if "ssm" not in sys.modules:
    _ssm = types.ModuleType("ssm")
    _ssm.get_param = lambda parameter_name: "test-token"
    sys.modules["ssm"] = _ssm

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_NUDGE_DIR = str(_REPO_ROOT / "lambda_goal_nudge")
_SHARED_DIR = str(_REPO_ROOT / "shared")
_COLLIDING = (
    "handler", "constants", "models", "encoders", "repository", "repository_base",
    "repository_transaction", "repository_category", "repository_budget",
    "repository_paycycle", "repository_balance", "repository_goals", "repository_device",
    "repository_notify", "repository_errors", "repository_insight", "repository_loanfacts",
    "repository_push_receipt", "push", "spend", "goal_pace", "goal_nudge",
)


@pytest.fixture
def handler():
    """Import lambda_goal_nudge/handler.py in isolation and hand it to the test."""
    for d in (_SHARED_DIR, _NUDGE_DIR):
        while d in sys.path:
            sys.path.remove(d)
    sys.path.insert(0, _SHARED_DIR)
    sys.path.insert(0, _NUDGE_DIR)

    saved = {name: sys.modules.pop(name, None) for name in _COLLIDING}
    import handler as h

    try:
        yield h
    finally:
        for name in _COLLIDING:
            sys.modules.pop(name, None)
        for name, mod in saved.items():
            if mod is not None:
                sys.modules[name] = mod
