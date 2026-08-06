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

import pathlib
import sys

import pytest

from _boto_stubs import install_import_satisfiers

# Env vars + fake boto3/botocore/ssm the handler import chain needs. Handler tests
# monkeypatch the repository, so the fakes are import-satisfiers only. The key fetch
# now lives in shared/api_key.py (WHIT-454); tests that need a key stub monkeypatch
# handler.get_api_key directly.
install_import_satisfiers(ssm_default="test-api-key")

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_POLLER_DIR = str(_REPO_ROOT / "lambda_balance_poller")
_SHARED_DIR = str(_REPO_ROOT / "shared")
# Names that collide with the sibling suites (lambda/lambda_api/sync_trigger),
# re-imported fresh per test so this package's copies win.
_COLLIDING = (
    "handler", "constants", "models", "encoders", "repository", "repository_base",
    "repository_transaction", "repository_category", "repository_budget",
    "repository_paycycle", "repository_balance", "repayment_rules", "api_key",
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

    try:
        yield h
    finally:
        for name in _COLLIDING:
            sys.modules.pop(name, None)
        for name, mod in saved.items():
            if mod is not None:
                sys.modules[name] = mod
