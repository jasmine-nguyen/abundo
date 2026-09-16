"""Test bootstrap for the ``shared/`` layer suite.

``shared/`` holds the flat top-level modules that the deployed Lambda layer
provides: ``constants`` / ``models`` / ``encoders`` / ``repository_base`` /
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

import copy
import pathlib
import sys
import types
from decimal import Decimal

import pytest

from _boto_stubs import install_import_satisfiers, use_condition_fields
# FakeTable + _client_error moved to _dynamo_fakes so a sibling suite (tests/scripts) can import
# them by basename (WHIT-532). Re-imported here so this conftest's fixtures and the
# conftest.FakeTable attribute are unchanged.
from _dynamo_fakes import FakeTable, _client_error

# Set the env vars + install fake boto3/botocore/ssm at module load, so
# shared/api_key.py's `from ssm import get_param` (and the repositories' boto imports)
# resolve. Tests that exercise the key fetch monkeypatch api_key.get_param. The `shared`
# fixture additionally swaps in the condition-recording Key/Attr via use_condition_fields.
install_import_satisfiers(ssm_default="shared-fake-key")


_SHARED_DIR = str(pathlib.Path(__file__).resolve().parents[2] / "shared")
# shared/ modules whose bare names collide with the sibling suites.
_REIMPORT = (
    "constants", "models", "encoders", "repository", "repository_base", "repository_transaction",
    "repository_balance", "repository_loanfacts", "repository_milestone", "repository_budget",
    "repository_goals", "repository_category",
    "repository_errors", "repository_insight", "repository_device", "push",
    "repository_push_receipt", "repository_notify", "spend", "budget_alerts",
    "repository_paycycle", "goal_pace", "goal_nudge", "goal_checkpoints", "milestones",
    "milestone_rows", "iso_date", "repayment_alerts", "repayment_rules", "api_key",
    "balance_fetch", "rule_engine", "repository_rule", "repository_job", "rule_smoothing",
)


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

    Standalone like api_key_module: rule_engine imports only `re`, so it needs neither the boto
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

        import encoders
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
        import repayment_alerts
        import repayment_rules
        import repository_rule
        import repository_job
        import rule_smoothing

        ns = types.SimpleNamespace(
            encoders=encoders, repository=repository_transaction,
            rule=repository_rule, job=repository_job, rule_smoothing=rule_smoothing,
            balance_fetch=balance_fetch,
            balance=repository_balance, loanfacts=repository_loanfacts,
            milestone=repository_milestone,
            budget=repository_budget, goals=repository_goals, insight=repository_insight,
            device=repository_device, push=push, push_receipt=repository_push_receipt,
            notify=repository_notify, spend=spend,
            goal_pace=goal_pace, goal_nudge=goal_nudge, goal_checkpoints=goal_checkpoints,
            milestones=milestones, milestone_rows=milestone_rows,
            repayment_alerts=repayment_alerts, repayment_rules=repayment_rules,
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


class ConfigItemTable:
    """In-memory stand-in for a single config item (pk=sk=``key``): an ``items`` map +
    a numeric ``version`` written under the ``attribute_exists(pk) AND #v = :expected``
    optimistic lock. Emulates the seed put_item (attribute_not_exists guard), the
    nested-map SET one key / REMOVE one key update, and a one-shot version race.

    The shared FakeTable above only parses flat SET expressions, so the budget and
    goals config-item repo suites each used to carry their own identical copy of this
    (WHIT-251). Build one per test via the ``config_item_table`` fixture.
    """

    def __init__(self, key, items=None, version=1, present=True):
        self.item = {
            "pk": key, "sk": key,
            "items": dict(items or {}), "version": Decimal(version),
        }
        self.present = present   # False -> config item never seeded
        self.update_calls = 0
        self.put_calls = 0
        self._bump_before_next_update = False

    def get_item(self, Key):
        return {"Item": copy.deepcopy(self.item)} if self.present else {}

    def put_item(self, Item, ConditionExpression=None):
        self.put_calls += 1
        # Seed guard: a present item makes attribute_not_exists fail (lost race -> no-op).
        if ConditionExpression == "attribute_not_exists(pk)" and self.present:
            raise _client_error("ConditionalCheckFailedException")
        self.item = copy.deepcopy(Item)
        self.present = True

    def race_next_update(self):
        """Arm a one-shot optimistic-lock race: the next update_item sees a version
        that moved under it (someone else wrote), then the retry converges."""
        self._bump_before_next_update = True

    def always_race(self):
        """Arm the lock race on EVERY update, so the optimistic-lock retry never converges:
        the repo exhausts its retry budget and raises VersionConflictError. Contrast
        race_next_update(), which loses exactly one update then converges. Call once per table."""
        original = self.update_item
        def armed_update(*args, **kwargs):
            self.race_next_update()
            return original(*args, **kwargs)
        self.update_item = armed_update

    def update_item(self, Key, UpdateExpression, ExpressionAttributeNames,
                    ExpressionAttributeValues, ConditionExpression=None):
        self.update_calls += 1
        if self._bump_before_next_update:
            self._bump_before_next_update = False
            self.item["version"] = self.item["version"] + Decimal(1)  # concurrent writer
        expected = ExpressionAttributeValues[":expected"]
        if not self.present or expected != self.item["version"]:
            raise _client_error("ConditionalCheckFailedException")
        item_id = ExpressionAttributeNames["#id"]
        if UpdateExpression.startswith("REMOVE"):
            self.item["items"].pop(item_id, None)                    # REMOVE #items.#id
        else:
            self.item["items"][item_id] = ExpressionAttributeValues[":val"]  # SET #items.#id = :val
        self.item["version"] = ExpressionAttributeValues[":next"]            # SET #v = :next


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
def balance_repo(shared):
    """A shared HomeLoanBalanceRepository backed by an in-memory FakeTable."""
    r = shared.balance.HomeLoanBalanceRepository()
    r._table = FakeTable()
    return r


@pytest.fixture
def account_balance_repo(shared):
    """A shared AccountBalanceRepository backed by an in-memory FakeTable."""
    r = shared.balance.AccountBalanceRepository()
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
    """Factory for a config-item table fake (pk=sk=key), seeded per test (WHIT-251).
    Call as ``config_item_table("BUDGETS", items=..., version=..., present=...)``."""
    return ConfigItemTable
