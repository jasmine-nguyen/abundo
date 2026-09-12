"""Test bootstrap for the import-script suite (WHIT-532).

scripts/import_banksync_rules.py is not an importable package module: it lives under scripts/ and,
like the deployed code, expects lambda_api/ ahead of shared/ on sys.path (so banksync_enrichments'
`from constants import ...` binds lambda_api's constants, not shared's). The `script` fixture below
loads it fresh per test via importlib — pinning the path and shedding the colliding bare module
names the sibling suites also use — and hands back the module plus a REAL RuleRepository backed by
the in-memory FakeTable. Driving the real repository is what makes the "an app text edit does not
resurrect the old rule" case fail-on-revert: the fake-vs-real move behaviour is the whole point.
"""

import importlib.util
import pathlib
import sys
import types

import pytest

from _boto_stubs import install_import_satisfiers, use_condition_fields
from _dynamo_fakes import FakeTable

# Env + fake boto3/botocore/ssm the import chain needs (repository_base reads TABLE_NAME/AWS_REGION
# at load; banksync_enrichments' api_key resolves `ssm`). Tests inject fakes, so these only satisfy
# imports.
install_import_satisfiers(ssm_default="test-api-key")

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_SHARED_DIR = str(_REPO_ROOT / "shared")
_LAMBDA_API_DIR = str(_REPO_ROOT / "lambda_api")
_SCRIPT_PATH = _REPO_ROOT / "scripts" / "import_banksync_rules.py"

# Bare names that collide with the sibling suites (lambda_api's own _COLLIDING is not importable
# from here, so keep a local copy) plus the repository_* names the script pulls in and the script
# module itself — all shed so a fresh, path-pinned import wins.
_COLLIDING = (
    "import_banksync_rules",
    "handler", "constants", "models", "encoders", "banksync_enrichments",
    "rule_engine", "api_key",
    "repository", "repository_base", "repository_errors", "repository_rule", "repository_category",
)


@pytest.fixture
def script():
    """Load scripts/import_banksync_rules.py in isolation with a real RuleRepository on a FakeTable."""
    for directory in (_SHARED_DIR, _LAMBDA_API_DIR):
        while directory in sys.path:
            sys.path.remove(directory)
    sys.path.insert(0, _SHARED_DIR)
    sys.path.insert(0, _LAMBDA_API_DIR)   # lambda_api first (mirrors prod)

    saved = {name: sys.modules.pop(name, None) for name in _COLLIDING}
    try:
        # The repositories bind the condition-recording Key/Attr at import, so FakeTable can
        # evaluate list_rules' Query — import them (and load the script) inside this context.
        with use_condition_fields():
            spec = importlib.util.spec_from_file_location("import_banksync_rules", _SCRIPT_PATH)
            module = importlib.util.module_from_spec(spec)
            sys.modules["import_banksync_rules"] = module
            spec.loader.exec_module(module)

            import repository_rule
            import repository_errors

            repo = repository_rule.RuleRepository()
            repo._table = FakeTable()

            yield types.SimpleNamespace(module=module, repo=repo, errors=repository_errors,
                                        table=repo._table, taxonomy=Taxonomy,
                                        delete_recorder=DeleteRecorder)
    finally:
        for name in _COLLIDING:
            sys.modules.pop(name, None)
        for name, original in saved.items():
            if original is not None:
                sys.modules[name] = original
        for directory in (_SHARED_DIR, _LAMBDA_API_DIR):
            while directory in sys.path:
                sys.path.remove(directory)


class Taxonomy:
    """Stand-in CategoryRepository: list_categories() only. Any other attribute access raises, so a
    test proves preview touched no other category method (write-free preview)."""

    def __init__(self, ids=("groceries", "petrol", "dining")):
        self._ids = list(ids)

    def list_categories(self):
        return [{"id": cid} for cid in self._ids]

    def __getattr__(self, name):
        raise AssertionError(f"CategoryRepository.{name} should not be called")


class DeleteRecorder:
    """Records the BankSync ids delete-from-banksync deletes; can fail on the Nth call."""

    def __init__(self, fail_on=None, error=None):
        self.calls = []
        self._fail_on = fail_on
        self._error = error

    def __call__(self, enrichment_id):
        self.calls.append(enrichment_id)
        if self._fail_on is not None and len(self.calls) == self._fail_on:
            raise self._error
