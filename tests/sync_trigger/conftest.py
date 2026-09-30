"""Backstage setup for the sync-trigger Lambda tests.

pytest loads this file automatically before running any test in this directory.
Its whole job is to make ``lambda_sync_trigger/handler.py`` *importable in a test
process*, which is not trivial because the handler imports two modules that only
exist inside the deployed Lambda layer:

    from constants import (...)   # real -> shared/constants.py
    from ssm import get_param     # shared/ssm.py, which imports boto3

We do three things, once, at collection time (before the handler is imported):

1. Put ``shared/`` and ``lambda_sync_trigger/`` on sys.path so ``import
   constants`` and ``import handler`` resolve the same way they do in the layer.
2. Register a fake ``ssm`` module so importing the handler does NOT drag in
   boto3. The real ssm.get_param talks to AWS; tests never want that.
3. Set AWS_REGION / TABLE_NAME and a fake boto3, for the repositories the
   pending mirror (WHIT-662) imports.

This must be plain module-level code (not a fixture): the handler's top-level
imports run during collection, before any fixture body executes, so a fixture
would be too late. Everything *runtime* (mocking urlopen, resetting the api-key
cache) is done per-test with monkeypatch in test_handler.py.
"""

import pathlib
import sys
import types

from _boto_stubs import install_import_satisfiers

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]

# 1. Make the layer-provided modules and the handler importable.
sys.path.insert(0, str(_REPO_ROOT / "shared"))
sys.path.insert(0, str(_REPO_ROOT / "lambda_sync_trigger"))

# 2. Stand in a fake `ssm` so `from ssm import get_param` succeeds without boto3.
#    Tests that care about SSM override api_key.get_param via monkeypatch (the key
#    fetch+cache now lives in shared/api_key.py); this default just keeps imports clean.
_fake_ssm = types.ModuleType("ssm")
_fake_ssm.get_param = lambda parameter_name: "test-api-key"
sys.modules["ssm"] = _fake_ssm

# 3. The handler imports pending_mirror (WHIT-662), which pulls in the shared repositories:
#    they read AWS_REGION / TABLE_NAME and import boto3 at load. This adds the env vars and a
#    fake boto3/botocore; the ssm fake above already stands.
install_import_satisfiers(ssm_default="test-api-key")
