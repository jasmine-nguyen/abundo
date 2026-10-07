"""Test bootstrap for the ``shared/`` layer suite.

``shared/`` holds the flat top-level modules that the deployed Lambda layer
provides: ``constants`` / ``models`` / ``repository_base`` /
``repository_transaction`` (and the other repository_* files). Their bare module
names collide with the ``lambda`` / ``lambda_api`` / ``sync_trigger`` suites, so —
mirroring ``tests/lambda/conftest.py`` — the fixtures below pin ``shared/`` to the
front of ``sys.path``, shed those names from ``sys.modules`` before importing so
``shared/``'s copies win, and restore everything afterwards.

``repository_base`` reads ``os.environ["AWS_REGION"]`` / ``["TABLE_NAME"]`` and
imports ``boto3`` / ``botocore`` at load, none of which is needed to unit-test the
repository logic. We set the env vars and register lightweight fake boto3/botocore
modules up front; the ``repo`` fixture injects an in-memory ``FakeTable`` so the
fake ``boto3.resource`` is never exercised. The fake ``Key``/``Attr`` (``_Field``)
record conditions that ``FakeTable`` can evaluate against a stored item.
"""

import pathlib
import sys
import types
from decimal import Decimal

import pytest

from _boto_stubs import install_import_satisfiers, use_condition_fields
from _dynamo_fakes import FakeTable, _client_error

# Set the env vars + install fake boto3/botocore at module load, so shared/api_key.py's
# ssm client (and the repositories' boto imports) resolve. Tests that exercise the key fetch monkeypatch api_key.get_param. The `shared`
# fixture additionally swaps in the condition-recording Key/Attr via use_condition_fields.
install_import_satisfiers()


_SHARED_DIR = str(pathlib.Path(__file__).resolve().parents[2] / "shared")
# Every shared/ module, shed and re-imported per test: their bare names collide with the sibling
# suites. Built from the folder so a new module needs no entry here.
_REIMPORT = tuple(sorted(path.stem for path in pathlib.Path(_SHARED_DIR).glob("*.py")))


@pytest.fixture
def api_key_module():
    """shared/api_key.py imported in isolation with an empty path-keyed cache."""
    while _SHARED_DIR in sys.path:
        sys.path.remove(_SHARED_DIR)
    sys.path.insert(0, _SHARED_DIR)
    saved = sys.modules.pop("api_key", None)
    import api_key

    api_key._cache.clear()
    try:
        yield api_key
    finally:
        sys.modules.pop("api_key", None)
        if saved is not None:
            sys.modules["api_key"] = saved
        while _SHARED_DIR in sys.path:
            sys.path.remove(_SHARED_DIR)


@pytest.fixture
def rule_engine():
    """shared/rule_engine.py imported in isolation — the pure rule-matching logic (WHIT-527).

    Standalone like api_key_module: rule_engine imports only `re` plus `constants` from shared/
    (already first on sys.path), so it needs neither the boto
    fakes nor the repository chain the `shared` fixture wires up."""
    while _SHARED_DIR in sys.path:
        sys.path.remove(_SHARED_DIR)
    sys.path.insert(0, _SHARED_DIR)
    saved = sys.modules.pop("rule_engine", None)
    import rule_engine

    try:
        yield rule_engine
    finally:
        sys.modules.pop("rule_engine", None)
        if saved is not None:
            sys.modules["rule_engine"] = saved
        while _SHARED_DIR in sys.path:
            sys.path.remove(_SHARED_DIR)


@pytest.fixture
def pending_carry():
    """shared/pending_carry.py imported in isolation — the pending edit check, twin matching and
    carry shared by the age-out and the hourly pending mirror (WHIT-663)."""
    with use_condition_fields():
        while _SHARED_DIR in sys.path:
            sys.path.remove(_SHARED_DIR)
        sys.path.insert(0, _SHARED_DIR)
        saved = {name: sys.modules.pop(name, None) for name in _REIMPORT}
        import pending_carry

        try:
            yield pending_carry
        finally:
            for name in _REIMPORT:
                sys.modules.pop(name, None)
                if saved[name] is not None:
                    sys.modules[name] = saved[name]
            while _SHARED_DIR in sys.path:
                sys.path.remove(_SHARED_DIR)


@pytest.fixture
def shared():
    """Import the shared layer's modules in isolation; yield the ones tests use.

    ``use_condition_fields`` installs the fake boto3/botocore and swaps in the
    condition-recording Key/Attr for the whole fixture, so the repositories bind
    ``_Field`` at import and FakeTable can evaluate their queries."""
    with use_condition_fields():
        while _SHARED_DIR in sys.path:
            sys.path.remove(_SHARED_DIR)
        sys.path.insert(0, _SHARED_DIR)
        saved_real = {name: sys.modules.pop(name, None) for name in _REIMPORT}

        import balance_fetch
        import repository_transaction
        import repository_balance
        import repository_loanfacts
        import repository_milestone
        import repository_budget
        import repository_goals
        import repository_insight
        import repository_device
        import push
        import repository_push_receipt
        import repository_notify
        import spend
        import goal_pace
        import goal_nudge
        import goal_checkpoints
        import milestone_rows
        import milestones
        import repayment_rules
        import repository_rule
        import repository_job
        import rule_spreading

        ns = types.SimpleNamespace(
            repository=repository_transaction,
            rule=repository_rule, job=repository_job, rule_spreading=rule_spreading,
            balance_fetch=balance_fetch,
            balance=repository_balance, loanfacts=repository_loanfacts,
            milestone=repository_milestone,
            budget=repository_budget, goals=repository_goals, insight=repository_insight,
            device=repository_device, push=push, push_receipt=repository_push_receipt,
            notify=repository_notify, spend=spend,
            goal_pace=goal_pace, goal_nudge=goal_nudge, goal_checkpoints=goal_checkpoints,
            milestones=milestones, milestone_rows=milestone_rows,
            repayment_rules=repayment_rules,
        )
        try:
            yield ns
        finally:
            for name in _REIMPORT:
                sys.modules.pop(name, None)
                if saved_real[name] is not None:
                    sys.modules[name] = saved_real[name]
            while _SHARED_DIR in sys.path:
                sys.path.remove(_SHARED_DIR)


@pytest.fixture
def database_error(shared):
    """The DatabaseError type handle_database_error raises (WHIT-127). Depends on
    `shared` so shared/ is on sys.path and this resolves the same class the repos do."""
    import repository_errors
    return repository_errors.DatabaseError


@pytest.fixture
def repo(shared):
    """A shared TransactionRepository backed by an in-memory FakeTable."""
    r = shared.repository.TransactionRepository()
    r._table = FakeTable()
    return r


@pytest.fixture
def rule_repo(shared):
    """A shared RuleRepository backed by an in-memory FakeTable (WHIT-528)."""
    r = shared.rule.RuleRepository()
    r._table = FakeTable()
    return r


@pytest.fixture
def job_repo(shared):
    """A shared JobRepository backed by an in-memory FakeTable (WHIT-537)."""
    r = shared.job.JobRepository()
    r._table = FakeTable()
    return r


@pytest.fixture
def account_balance_repo(shared):
    """A shared AccountBalanceRepository backed by an in-memory FakeTable."""
    r = shared.balance.AccountBalanceRepository()
    r._table = FakeTable()
    return r


@pytest.fixture
def feed_watch_repo(shared):
    """A shared FeedWatchRepository backed by an in-memory FakeTable."""
    r = shared.balance.FeedWatchRepository()
    r._table = FakeTable()
    return r


@pytest.fixture
def insight_repo(shared):
    """A shared InsightRepository backed by an in-memory FakeTable."""
    r = shared.insight.InsightRepository()
    r._table = FakeTable()
    return r


@pytest.fixture
def loanfacts_repo(shared):
    """A shared LoanFactsRepository backed by an in-memory FakeTable."""
    r = shared.loanfacts.LoanFactsRepository()
    r._table = FakeTable()
    return r


@pytest.fixture
def milestone_repo(shared):
    """A shared MilestoneRepository backed by an in-memory FakeTable."""
    r = shared.milestone.MilestoneRepository()
    r._table = FakeTable()
    return r


@pytest.fixture
def client_error():
    """Factory for a botocore-shaped ClientError, for driving the error paths."""
    return _client_error


@pytest.fixture
def config_item_table():
    """Factory for a FakeTable holding one config item (pk=sk=key): an ``items`` map plus a
    numeric ``version`` (WHIT-251, WHIT-625). ``present=False`` leaves the table empty.
    Call as ``config_item_table("BUDGETS", items=..., version=..., present=...)``."""
    def build(key, items=None, version=1, present=True):
        table = FakeTable()
        if present:
            table.seed({"pk": key, "sk": key, "items": dict(items or {}), "version": Decimal(version)})
        return table
    return build
