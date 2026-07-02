"""Test bootstrap for the lambda_api handler suite.

Two things make importing ``lambda_api/handler.py`` in a test non-trivial:

1. It transitively imports ``shared/repository.py``, which at module load reads
   ``os.environ["AWS_REGION"]`` / ``["TABLE_NAME"]`` (repository.py:15-16) and
   imports ``boto3`` / ``botocore`` (repository.py:8-10). None of that is needed
   to unit-test the handler's routing/validation, so we set the env vars and
   register lightweight fake boto3/botocore modules before the first import.
   Handler tests replace the repository wholesale, so the fakes are never
   exercised — they only satisfy the import chain (same approach the
   sync_trigger suite uses to avoid a real ssm/boto3 dependency).

2. ``lambda_api`` and ``lambda_sync_trigger`` BOTH have top-level ``handler.py``
   and ``constants.py``. Running both suites in one pytest process means a bare
   ``import handler`` could return whichever the sibling suite cached first. The
   ``handler`` fixture below sheds those names from sys.modules and pins this
   package's dirs to the front of sys.path before importing, then restores the
   module table so the sibling suite still imports its own copies.
"""

import os
import pathlib
import sys
import types

import pytest

# 1a. Env vars repository.py reads at import time.
os.environ.setdefault("AWS_REGION", "ap-southeast-2")
os.environ.setdefault("TABLE_NAME", "test-table")

# 1b. Fake boto3 / botocore so importing the shared repository needs no AWS deps.
#     Handler tests monkeypatch the repository, so these are import-satisfiers only.
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

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_LAMBDA_API_DIR = str(_REPO_ROOT / "lambda_api")
_SHARED_DIR = str(_REPO_ROOT / "shared")
# Modules whose names collide with the sibling sync_trigger suite.
_COLLIDING = ("handler", "constants", "models", "encoders", "repository")


@pytest.fixture
def handler():
    """Import lambda_api/handler.py in isolation and hand it to the test."""
    for d in (_SHARED_DIR, _LAMBDA_API_DIR):
        while d in sys.path:
            sys.path.remove(d)
    # lambda_api first so its constants/models/handler win (mirrors prod, where
    # the function root precedes the shared layer); repository resolves in shared.
    sys.path.insert(0, _SHARED_DIR)
    sys.path.insert(0, _LAMBDA_API_DIR)

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
