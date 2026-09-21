"""The app_api role's DynamoDB grant must cover exactly what the repository code calls — and
its DeleteItem must stay scoped to rule rows.

Same class of miss as WHIT-506 (code perfect, deploy wrong): if a repository method calls a
DynamoDB verb the `app_api_dynamodb` IAM policy doesn't grant, every request on that path 500s
at runtime with AccessDenied — nothing in the test suite would catch it. And DeleteItem is
newly granted (WHIT-528) under a `dynamodb:LeadingKeys = ["RULE"]` condition, so the API can
only ever delete rule rows; this pins that the code never tries to delete anything else.

Static: parses terraform/iam.tf and AST-scans the shared repository modules. Imports nothing
(those modules need env + boto3 at load). It checks POLICY TEXT + call sites — AWS's actual
enforcement of the LeadingKeys condition is verified once, live, after `terraform apply`.

`repository_push_receipt` / `repository_notify` run on OTHER roles and are deliberately not
imported by `repository.py`, so they are outside this scan (their deletes are that role's
concern).
"""

import ast
import pathlib
import re

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_SHARED = _REPO_ROOT / "shared"
_IAM = _REPO_ROOT / "terraform" / "iam.tf"
_FACADE = _SHARED / "repository.py"

# boto3 Table method -> the IAM action it needs. batch_writer maps to BatchWriteItem; it is
# called through a local `table` var in repository_transaction, NOT self._get_table().<verb>(,
# so the direct-chain scan below deliberately does not see it (and the role omits it).
_VERB_TO_ACTION = {
    "get_item": "GetItem",
    "put_item": "PutItem",
    "query": "Query",
    "update_item": "UpdateItem",
    "delete_item": "DeleteItem",
    "batch_writer": "BatchWriteItem",
}


def _app_api_policy_block() -> str:
    """The text of the `app_api_dynamodb` resource, sliced to the next `resource "` marker."""
    source = _IAM.read_text()
    start = source.index('resource "aws_iam_role_policy" "app_api_dynamodb"')
    rest = source[start:]
    # The block ends at the next top-level resource declaration.
    end = rest.index('\nresource "', 1)
    return rest[:end]


def _granted_actions() -> set[str]:
    block = _app_api_policy_block()
    # `"dynamodb:LeadingKeys"` also matches the action pattern (it is a condition key, not an
    # action), so drop it explicitly.
    return {name for name in re.findall(r'"dynamodb:(\w+)"', block)} - {"LeadingKeys"}


def _leading_keys() -> set[str]:
    block = _app_api_policy_block()
    match = re.search(r'"dynamodb:LeadingKeys"\s*=\s*\[([^\]]*)\]', block)
    assert match, "app_api_dynamodb has no dynamodb:LeadingKeys condition — the DeleteItem scope is gone"
    return set(re.findall(r'"([^"]+)"', match.group(1)))


def _scanned_modules() -> list[pathlib.Path]:
    """The repository modules the app_api role loads: everything repository.py imports by
    `from repository_* import ...`. repository_rule is in there (the facade exports it)."""
    names = set(re.findall(r'^from (repository_\w+) import', _FACADE.read_text(), re.MULTILINE))
    assert "repository_rule" in names, "repository.py no longer imports repository_rule"
    return [_SHARED / f"{name}.py" for name in sorted(names)]


def _is_get_table_chain(node: ast.AST) -> bool:
    """True for `self._get_table()` — the receiver of a direct table-verb chain."""
    return (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "_get_table"
    )


def _table_verb_calls(tree: ast.AST):
    """Yield (verb, call_node) for every `self._get_table().<verb>(...)` call."""
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and _is_get_table_chain(node.func.value)
        ):
            yield node.func.attr, node


def _needed_actions_and_deletes():
    needed = set()
    delete_calls = []
    for module in _scanned_modules():
        tree = ast.parse(module.read_text())
        for verb, call in _table_verb_calls(tree):
            assert verb in _VERB_TO_ACTION, (
                f"{module.name} calls self._get_table().{verb}() — add it to _VERB_TO_ACTION "
                "so the IAM guard knows which action it needs"
            )
            needed.add(_VERB_TO_ACTION[verb])
            if verb == "delete_item":
                delete_calls.append((module.name, call))
    return needed, delete_calls


def _delete_pk_literal(call: ast.Call):
    """The literal string passed as Key={"pk": ...}, or None if it isn't a plain literal."""
    for keyword in call.keywords:
        if keyword.arg != "Key" or not isinstance(keyword.value, ast.Dict):
            continue
        for key, value in zip(keyword.value.keys, keyword.value.values):
            if isinstance(key, ast.Constant) and key.value == "pk":
                return value.value if isinstance(value, ast.Constant) else None
    return None


def test_the_scan_finds_real_call_sites_and_grants():
    # Guards a vacuous pass: if either the tf parse or the AST scan stops matching, the
    # assertions below compare empty sets and "pass" while checking nothing.
    granted = _granted_actions()
    needed, delete_calls = _needed_actions_and_deletes()
    assert {"GetItem", "PutItem", "Query", "UpdateItem", "DeleteItem"} <= granted
    assert "DeleteItem" in needed, "no repository calls delete_item — the scan is broken"
    assert delete_calls, "found no delete_item call sites to pin the pk on"


def test_every_dynamodb_verb_the_repositories_call_is_granted():
    granted = _granted_actions()
    needed, _ = _needed_actions_and_deletes()
    missing = sorted(needed - granted)
    assert missing == [], (
        "the app_api repository code calls DynamoDB verbs the app_api_dynamodb IAM policy does "
        f"not grant, so those requests 500 with AccessDenied at runtime: {missing}"
    )


def test_delete_item_only_ever_targets_rule_rows():
    # The security invariant behind the scoped grant: the code must only delete items whose pk
    # equals the LeadingKeys value, so a bug can never delete a non-rule row (and the grant
    # would deny it anyway).
    leading_keys = _leading_keys()
    assert leading_keys == {"RULE"}, f"unexpected LeadingKeys scope: {leading_keys}"
    _, delete_calls = _needed_actions_and_deletes()
    for module_name, call in delete_calls:
        pk = _delete_pk_literal(call)
        assert pk in leading_keys, (
            f"{module_name} calls delete_item with pk={pk!r}, which is not the IAM-scoped "
            f"LeadingKeys value {leading_keys}; the delete would be denied (or, worse, isn't "
            "pinned to a rule row). Pass Key={'pk': 'RULE', ...} as a literal."
        )
