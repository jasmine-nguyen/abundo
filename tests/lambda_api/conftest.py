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

import pathlib
import sys

import pytest

from _boto_stubs import install_import_satisfiers

# Env vars + fake boto3/botocore/ssm the handler import chain needs. Handler tests
# monkeypatch the repository (and banksync_enrichments' key), so the fakes are
# import-satisfiers only.
install_import_satisfiers(ssm_default="test-api-key")

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_LAMBDA_API_DIR = str(_REPO_ROOT / "lambda_api")
_SHARED_DIR = str(_REPO_ROOT / "shared")
# Modules re-imported fresh per test: names that collide with the sibling
# sync_trigger suite, plus banksync_enrichments (so its cached _api_key can't
# leak across tests).
_COLLIDING = (
    "handler", "constants", "models", "encoders", "repository",
    "banksync_enrichments", "insights_ai", "anthropic_client",
    "spend", "repayment_rules", "api_key",
)


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


@pytest.fixture
def insights_ai():
    """Import lambda_api/insights_ai.py in isolation for direct tests of
    generate_suggestions / _parse_reply. The key/HTTP plumbing now lives in
    anthropic_client (WHIT-388), so pin the key there — insights_ai delegates the
    call to it."""
    for d in (_SHARED_DIR, _LAMBDA_API_DIR):
        while d in sys.path:
            sys.path.remove(d)
    sys.path.insert(0, _SHARED_DIR)
    sys.path.insert(0, _LAMBDA_API_DIR)

    saved = {name: sys.modules.pop(name, None) for name in _COLLIDING}
    import insights_ai as ia
    import anthropic_client as ac
    import api_key

    api_key._cache.clear()  # never leak a cached key across tests
    api_key.get_param = lambda path: "test-anthropic-key"
    try:
        yield ia
    finally:
        for name in _COLLIDING:
            sys.modules.pop(name, None)
        for name, mod in saved.items():
            if mod is not None:
                sys.modules[name] = mod


@pytest.fixture
def anthropic_client():
    """Import lambda_api/anthropic_client.py in isolation for direct tests of the
    shared Anthropic client (post / extract_first_json / get_api_key)."""
    for d in (_SHARED_DIR, _LAMBDA_API_DIR):
        while d in sys.path:
            sys.path.remove(d)
    sys.path.insert(0, _SHARED_DIR)
    sys.path.insert(0, _LAMBDA_API_DIR)

    saved = {name: sys.modules.pop(name, None) for name in _COLLIDING}
    import anthropic_client as ac
    import api_key

    api_key._cache.clear()  # never leak a cached key across tests
    api_key.get_param = lambda path: "test-anthropic-key"
    try:
        yield ac
    finally:
        for name in _COLLIDING:
            sys.modules.pop(name, None)
        for name, mod in saved.items():
            if mod is not None:
                sys.modules[name] = mod


@pytest.fixture
def enrichments():
    """Import lambda_api/banksync_enrichments.py in isolation for direct tests
    of the BankSync client + Rule adapter (create/list/delete/_to_rule)."""
    for d in (_SHARED_DIR, _LAMBDA_API_DIR):
        while d in sys.path:
            sys.path.remove(d)
    sys.path.insert(0, _SHARED_DIR)
    sys.path.insert(0, _LAMBDA_API_DIR)

    saved = {name: sys.modules.pop(name, None) for name in _COLLIDING}
    import banksync_enrichments as be
    import api_key

    api_key._cache.clear()  # never leak a cached key across tests
    # Pin the key deterministically instead of leaning on whichever suite's
    # module-level `ssm` fake won collection order — otherwise value-sensitive tests
    # are order-dependent. Tests that care about the fetch monkeypatch api_key.get_param.
    api_key.get_param = lambda path: "test-api-key"
    try:
        yield be
    finally:
        for name in _COLLIDING:
            sys.modules.pop(name, None)
        for name, mod in saved.items():
            if mod is not None:
                sys.modules[name] = mod
