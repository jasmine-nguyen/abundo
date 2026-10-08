"""WHIT-678: the transaction-trigger role must be granted every DynamoDB action the pending
mirror's repository calls need.

Live miss: the mirror carries a user's edit onto a re-issued pending via `carry_onto_pending`
(an UpdateItem), but the `transaction_trigger_dynamodb` policy didn't grant UpdateItem, so AWS
answered AccessDenied, the log said "carry failed, keeping" and the double stayed. FakeTable
never checks IAM, so nothing in the suite noticed.

Static: parses terraform/iam.tf and AST-scans lambda_sync_trigger/pending_mirror.py and
shared/repository_transaction.py. Imports neither (they need env + boto3 at load).

The category repository is left out on purpose: the mirror only reads categories, and the
read path never writes.
"""

import ast
import pathlib
import re

from _terraform import DYNAMODB_VERB_TO_ACTION, TERRAFORM_DIR, granted_dynamodb_actions, leading_keys, tf_block

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_IAM = TERRAFORM_DIR / "iam.tf"
_MIRROR = _REPO_ROOT / "lambda_sync_trigger" / "pending_mirror.py"
_TRANSACTION_REPO = _REPO_ROOT / "shared" / "repository_transaction.py"

# Reached through read_date_range_pages(repo, ...) in pending_mirror.py, which the `repo.`
# regex can't see.
_INDIRECT_METHODS = {"get_transactions_by_date_range"}


def _policy_block() -> str:
    return tf_block(_IAM.read_text(), "aws_iam_role_policy", "transaction_trigger_dynamodb")


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


def test_the_scan_finds_the_trigger_call_sites():
    called, needed = _needed_actions()
    assert len(called) >= 3, f"resolved too few repository methods: {sorted(called)}"
    assert {"UpdateItem", "DeleteItem", "BatchWriteItem", "Query"} <= needed, (
        f"the scan stopped seeing the mirror's DynamoDB calls: {sorted(needed)}"
    )


def test_every_dynamodb_action_the_pending_mirror_needs_is_granted():
    granted = granted_dynamodb_actions(_policy_block())
    _, needed = _needed_actions()
    missing = sorted(needed - granted)
    assert missing == [], (
        "the pending mirror's repository calls use DynamoDB actions the "
        "transaction_trigger_dynamodb IAM policy does not grant, so AWS answers AccessDenied at "
        f"runtime (e.g. 'carry failed, keeping'): {missing}"
    )


def test_update_item_is_scoped_to_transaction_rows():
    block = _policy_block()
    assert leading_keys(block) == ["ACCOUNT#*"], (
        "transaction_trigger_dynamodb has no dynamodb:LeadingKeys condition on UpdateItem")
    assert '"ForAllValues:StringLike"' in block, "the ACCOUNT#* wildcard only matches under StringLike"
