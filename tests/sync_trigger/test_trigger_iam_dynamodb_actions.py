"""WHIT-678: the transaction-trigger role must be granted every DynamoDB action the pending
mirror's repository calls need.

Live miss: the mirror carries a user's edit onto a re-issued pending via `carry_onto_pending`
(an UpdateItem), but the `transaction_trigger_dynamodb` policy didn't grant UpdateItem, so AWS
answered AccessDenied, the log said "carry failed, keeping" and the double stayed. FakeTable
never checks IAM, so nothing in the suite noticed.

Static: parses terraform/iam.tf and AST-scans lambda_sync_trigger/pending_mirror.py and
shared/repository_transaction.py. Imports neither (they need env + boto3 at load).

The category repository is left out of the scan on purpose: the mirror only reads categories,
and the read path never writes.

Below the scan, the WHIT-678 live incident (Cettire + SP RUSHFASTERAU) is replayed through a
FakeTable that enforces the trigger policy statement by statement.
"""

import ast
import importlib
import pathlib
import re
from decimal import Decimal

import pytest
from _dynamo_fakes import FakeTable, _client_error
from _pending_mirror_fakes import (
    CETTIRE_NEW,
    CETTIRE_OLD,
    REISSUE_TODAY,
    RUSH_NEW,
    RUSH_OLD,
    WESTPAC,
    reissue_bank_rows,
    run_mirror,
    unfiled_except,
)
from _terraform import (
    DYNAMODB_VERB_TO_ACTION,
    TERRAFORM_DIR,
    allows,
    granted_dynamodb_actions,
    policy_statements,
    tf_block,
)

POLICY = "transaction_trigger_dynamodb"
_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_IAM = TERRAFORM_DIR / "iam.tf"
_MIRROR = _REPO_ROOT / "lambda_sync_trigger" / "pending_mirror.py"
_TRANSACTION_REPO = _REPO_ROOT / "shared" / "repository_transaction.py"

# Reached through read_date_range_pages(repo, ...) in pending_mirror.py, which the `repo.`
# regex can't see.
_INDIRECT_METHODS = {"get_transactions_by_date_range"}


def _policy_block() -> str:
    return tf_block(_IAM.read_text(), "aws_iam_role_policy", POLICY)


def _repository_methods() -> dict[str, ast.FunctionDef]:
    tree = ast.parse(_TRANSACTION_REPO.read_text())
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == "TransactionRepository":
            return {item.name: item for item in node.body if isinstance(item, ast.FunctionDef)}
    raise AssertionError("TransactionRepository class not found in repository_transaction.py")


def _called_methods() -> set[str]:
    return set(re.findall(r"\brepo\.(\w+)\(", _MIRROR.read_text())) | _INDIRECT_METHODS


def _is_get_table(node: ast.AST) -> bool:
    return (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "_get_table"
    )


def _verbs_in(function: ast.FunctionDef) -> set[str]:
    """Verbs called on the table itself: `self._get_table().<verb>(` or `<name>.<verb>(` where
    `<name> = self._get_table()`. Not `batch.put_item` inside a batch_writer (that's BatchWriteItem)."""
    table_names = {
        target.id
        for node in ast.walk(function)
        if isinstance(node, ast.Assign) and _is_get_table(node.value)
        for target in node.targets
        if isinstance(target, ast.Name)
    }
    verbs = set()
    for node in ast.walk(function):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)):
            continue
        receiver = node.func.value
        on_table = _is_get_table(receiver) or (isinstance(receiver, ast.Name) and receiver.id in table_names)
        if on_table and node.func.attr in DYNAMODB_VERB_TO_ACTION:
            verbs.add(node.func.attr)
    return verbs


def _self_calls_in(function: ast.FunctionDef) -> set[str]:
    return {
        node.func.attr
        for node in ast.walk(function)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "self"
    }


def _needed_actions() -> tuple[set[str], set[str]]:
    methods = _repository_methods()
    called = _called_methods()
    needed = set()
    for name in called:
        assert name in methods, (
            f"pending_mirror.py calls repo.{name}() but TransactionRepository has no such method"
        )
        functions = [methods[name]] + [
            methods[helper] for helper in _self_calls_in(methods[name]) if helper in methods
        ]
        for function in functions:
            needed |= {DYNAMODB_VERB_TO_ACTION[verb] for verb in _verbs_in(function)}
    return called, needed


def test_every_dynamodb_action_the_pending_mirror_needs_is_granted():
    called, needed = _needed_actions()
    assert len(called) >= 3, f"resolved too few repository methods: {sorted(called)}"
    assert {"UpdateItem", "DeleteItem", "BatchWriteItem", "Query"} <= needed, (
        f"the scan stopped seeing the mirror's DynamoDB calls: {sorted(needed)}"
    )
    granted = granted_dynamodb_actions(_policy_block())
    missing = sorted(needed - granted)
    assert missing == [], (
        "the pending mirror's repository calls use DynamoDB actions the "
        "transaction_trigger_dynamodb IAM policy does not grant, so AWS answers AccessDenied at "
        f"runtime (e.g. 'carry failed, keeping'): {missing}"
    )


# --- the trigger policy enforced against the mirror's real calls (WHIT-678 live incident) -------
# A FakeTable that refuses, with AccessDenied, any call the trigger policy would refuse, including
# the LeadingKeys scope.


def _pk_of(operation, subject):
    if operation == "query":
        return None
    return subject.get("pk")


def _access_denied():
    return _client_error("AccessDeniedException", "not authorized (trigger role)")


def _enforce_trigger_policy(table: FakeTable) -> FakeTable:
    statements = policy_statements(POLICY)
    for operation, action in DYNAMODB_VERB_TO_ACTION.items():
        table.fail(
            operation,
            error=_access_denied(),
            when=lambda subject, operation=operation, action=action: not allows(
                statements, action, _pk_of(operation, subject)),
        )
    return table


@pytest.fixture
def repo(layer):
    repository = layer[0].TransactionRepository()
    repository._table = _enforce_trigger_policy(FakeTable())
    return repository


def test_the_rush_and_cettire_doubles_are_removed_with_notes_kept_under_the_trigger_policy(mirror, repo, row):
    repo._table.seed(
        row("old_cettire", CETTIRE_OLD, "-260.36", category="shopping", notes="The North Face Jacket"),
        row("new_cettire", CETTIRE_NEW, "-260.36", category="shopping", filed_by_rule="rule-1"),
        row("old_rush", RUSH_OLD, "-192.00", day="2026-09-29", category="shopping", notes="Patagonia Backpack"),
        row("new_rush", RUSH_NEW, "-192.00", category="shopping", filed_by_rule="rule-1"),
    )
    bank = reissue_bank_rows("new_cettire", "new_rush")

    result = run_mirror(mirror, repo, bank, unfiled_except("shopping", "clothing"), REISSUE_TODAY)

    assert result["failed"] == 0, f"a call was refused by the trigger policy (AccessDenied): {result}"
    assert result["carried"] == 2
    keys = {key[1] for key in repo._table.store}
    assert keys == {"TXN#new_cettire", "TXN#new_rush"}
    assert repo._table.store[(f"ACCOUNT#{WESTPAC}", "TXN#new_cettire")]["notes"] == "The North Face Jacket"
    assert repo._table.store[(f"ACCOUNT#{WESTPAC}", "TXN#new_rush")]["notes"] == "Patagonia Backpack"


def test_the_category_read_succeeds_under_the_trigger_policy_without_writing(layer):
    repository_category = importlib.import_module("repository_category")
    pending_carry = importlib.import_module("pending_carry")
    category_repo = repository_category.CategoryRepository()
    table = _enforce_trigger_policy(FakeTable())
    table.seed({"pk": "CATEGORIES", "sk": "CATEGORIES",
                "items": dict(repository_category.SEED_CATEGORIES), "version": Decimal(1)})
    category_repo._table = table

    is_unfiled = pending_carry.load_is_unfiled(category_repo)

    assert table.update_keys == [], "a category read must not write"
    assert is_unfiled("not-a-category")
    assert not is_unfiled(next(iter(repository_category.SEED_CATEGORIES)))
