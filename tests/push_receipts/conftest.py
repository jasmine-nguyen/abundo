"""Test bootstrap for the push-receipts sweep Lambda suite (WHIT-139).

``lambda_push_receipts/handler.py`` imports ``push``, ``repository_push_receipt`` and
``repository_device`` from the shared layer; ``push`` does ``from ssm import get_param``
at load, and the repositories read ``AWS_REGION``/``TABLE_NAME`` and import
``boto3``/``botocore``. None of that AWS wiring is needed to unit-test the sweep logic —
the handler tests monkeypatch ``handler.PushReceiptRepository`` /
``handler.DeviceRepository`` / ``handler.get_receipts`` / ``handler.get_access_token``,
so the fakes below only satisfy the import chain.

``handler``/``push``/``repository_*`` collide with the sibling suites, so the ``handler``
fixture sheds those names, pins this package's dirs to the front of ``sys.path``, imports,
then restores — the same isolation the balance-poller conftest uses.
"""

import os
import pathlib
import sys
import types

import pytest

# Env vars repository_base.py reads at import time.
os.environ.setdefault("AWS_REGION", "ap-southeast-2")
os.environ.setdefault("TABLE_NAME", "test-table")

# Fake boto3 / botocore so importing the shared repositories needs no AWS deps.
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

# Fake `ssm` so `from ssm import get_param` succeeds without boto3/AWS. Tests that care
# about the token monkeypatch handler.get_access_token directly.
if "ssm" not in sys.modules:
    _ssm = types.ModuleType("ssm")
    _ssm.get_param = lambda parameter_name: "test-token"
    sys.modules["ssm"] = _ssm

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_SWEEP_DIR = str(_REPO_ROOT / "lambda_push_receipts")
_SHARED_DIR = str(_REPO_ROOT / "shared")
# Names that collide with the sibling suites, re-imported fresh per test so this
# package's copies win.
_COLLIDING = (
    "handler", "push", "repository_push_receipt", "repository_device", "repository_base",
)


@pytest.fixture
def handler():
    """Import lambda_push_receipts/handler.py in isolation and hand it to the test."""
    for d in (_SHARED_DIR, _SWEEP_DIR):
        while d in sys.path:
            sys.path.remove(d)
    # sweep dir first so its handler wins; push/repositories resolve in shared.
    sys.path.insert(0, _SHARED_DIR)
    sys.path.insert(0, _SWEEP_DIR)

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
