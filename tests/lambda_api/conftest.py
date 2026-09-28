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

2. ``lambda_api`` and ``lambda_sync_trigger`` BOTH have a top-level ``handler.py``.
   Running both suites in one pytest process means a bare
   ``import handler`` could return whichever the sibling suite cached first. The
   ``handler`` fixture below sheds those names from sys.modules and pins this
   package's dirs to the front of sys.path before importing, then restores the
   module table so the sibling suite still imports its own copies.
"""

import contextlib
import importlib
import pathlib
import sys

import pytest

from _boto_stubs import install_import_satisfiers

# Env vars + fake boto3/botocore/ssm the handler import chain needs. Handler tests
# monkeypatch the repository, so the fakes are import-satisfiers only.
install_import_satisfiers(ssm_default="test-api-key")

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_LAMBDA_API_DIR = str(_REPO_ROOT / "lambda_api")
_SHARED_DIR = str(_REPO_ROOT / "shared")
# Modules re-imported fresh per test: every lambda_api/ module, plus the shared/ modules whose bare
# name another lambda folder also defines (e.g. `repository`). Built from the folders so a new
# module needs no entry here. Shedding every shared/ module too is correct but ~70% slower.
# `api_key` is always shed: it caches keys and the Anthropic fixtures below stub its get_param.
_OTHER_DIRS = [folder for folder in _REPO_ROOT.glob("lambda*") if folder.name != "lambda_api"]
_COLLIDING = tuple(sorted(
    {path.stem for path in pathlib.Path(_LAMBDA_API_DIR).glob("*.py")}
    | ({path.stem for path in pathlib.Path(_SHARED_DIR).glob("*.py")}
       & {path.stem for folder in _OTHER_DIRS for path in folder.glob("*.py")})
    | {"api_key"}
))


@contextlib.contextmanager
def _isolated_import(module_name):
    """Import one lambda_api (or shared) module fresh for a test, then restore sys.modules.

    lambda_api's dir goes first on sys.path (mirrors prod, where the function root precedes the
    shared layer); constants and repository resolve in shared."""
    for d in (_SHARED_DIR, _LAMBDA_API_DIR):
        while d in sys.path:
            sys.path.remove(d)
    sys.path.insert(0, _SHARED_DIR)
    sys.path.insert(0, _LAMBDA_API_DIR)

    saved = {name: sys.modules.pop(name, None) for name in _COLLIDING}
    try:
        yield importlib.import_module(module_name)
    finally:
        for name in _COLLIDING:
            sys.modules.pop(name, None)
        for name, mod in saved.items():
            if mod is not None:
                sys.modules[name] = mod


@pytest.fixture
def handler():
    """Import lambda_api/handler.py in isolation and hand it to the test."""
    with _isolated_import("handler") as module:
        yield module


@pytest.fixture
def apply_rules_worker():
    """Import lambda_api/apply_rules_worker.py in isolation (WHIT-537). It shares the handler's
    imports (repository, api_constants, rule_engine), so this sheds the same colliding names first."""
    with _isolated_import("apply_rules_worker") as module:
        yield module


@pytest.fixture
def rule_engine():
    """Import the shared rule_engine in isolation — the pure rule-matching logic, tested
    without the handler's scan or writes. Lives in shared/ (WHIT-527) but the merchant/apply
    suites here exercise it against the handler, so it is imported the same way as the siblings."""
    with _isolated_import("rule_engine") as module:
        yield module


@pytest.fixture
def recurring_bills():
    """Import lambda_api/recurring_bills.py in isolation — the pure recurring-bill detector
    (WHIT-559 prereq), tested without the handler's scan or writes."""
    with _isolated_import("recurring_bills") as module:
        yield module


@pytest.fixture
def transaction_search():
    """Import lambda_api/transaction_search.py in isolation — the pure search matcher (WHIT-576),
    tested without the handler's full-history scan."""
    with _isolated_import("transaction_search") as module:
        yield module


@pytest.fixture
def insights_ai():
    """Import lambda_api/insights_ai.py in isolation for direct tests of
    generate_suggestions / _parse_reply. The key/HTTP plumbing now lives in
    anthropic_client (WHIT-388), so pin the key there — insights_ai delegates the
    call to it."""
    with _isolated_import("insights_ai") as module:
        import api_key

        api_key._cache.clear()  # never leak a cached key across tests
        api_key.get_param = lambda path: "test-anthropic-key"
        yield module


@pytest.fixture
def anthropic_client():
    """Import lambda_api/anthropic_client.py in isolation for direct tests of the
    shared Anthropic client (post / extract_first_json / get_api_key)."""
    with _isolated_import("anthropic_client") as module:
        import api_key

        api_key._cache.clear()  # never leak a cached key across tests
        api_key.get_param = lambda path: "test-anthropic-key"
        yield module


@pytest.fixture
def chat_tools():
    """Import lambda_api/chat_tools.py in isolation — the Ask Abundo data tools (card 609), pure
    maths over an in-memory ChatData."""
    with _isolated_import("chat_tools") as module:
        yield module


@pytest.fixture
def ai_chat():
    """Import lambda_api/ai_chat.py in isolation — the chat worker (card 609). It imports the
    handler for the windowed read and /budgets, so this sheds the same colliding names first."""
    with _isolated_import("ai_chat") as module:
        yield module
