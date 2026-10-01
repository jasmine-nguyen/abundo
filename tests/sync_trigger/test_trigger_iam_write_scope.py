"""WHIT-679: the hourly clean-up (transaction trigger) may only write to charge rows.

Delete and bulk save (BatchWriteItem can also delete) must sit in the ACCOUNT#*-scoped
statement, like UpdateItem since PR #621. Otherwise a bug in the clean-up could delete
CATEGORIES, RULE or device rows.
"""

import fnmatch
import re

import pytest
from _terraform import TERRAFORM_DIR, granted_dynamodb_actions, tf_block

WRITE_ACTIONS = ("UpdateItem", "DeleteItem", "BatchWriteItem")
NON_CHARGE_PKS = ("CATEGORIES", "RULE", "DEVICE#abc", "FAILED#abc")


def _statements():
    block = tf_block((TERRAFORM_DIR / "iam.tf").read_text(), "aws_iam_role_policy", "transaction_trigger_dynamodb")
    body = block[block.index("Statement"):]
    statements, depth, start = [], 0, None
    for position, char in enumerate(body):
        if char == "{":
            if depth == 0:
                start = position
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                statements.append(body[start:position + 1])
            if depth < 0:
                break
    return statements


def _leading_keys(statement):
    match = re.search(r'"dynamodb:LeadingKeys"\s*=\s*\[([^\]]*)\]', statement)
    if match is None:
        return None
    return re.findall(r'"([^"]+)"', match.group(1))


def _allows(action, pk):
    for statement in _statements():
        if action not in granted_dynamodb_actions(statement):
            continue
        patterns = _leading_keys(statement)
        if patterns is None:
            return True
        if any(fnmatch.fnmatchcase(pk, pattern) for pattern in patterns):
            return True
    return False


def test_the_unscoped_statements_grant_only_reads():
    unscoped = set()
    for statement in _statements():
        if _leading_keys(statement) is None:
            unscoped |= granted_dynamodb_actions(statement)
    assert unscoped == {"GetItem", "Query"}, f"unscoped trigger grants beyond reads: {sorted(unscoped)}"


@pytest.mark.parametrize("action", WRITE_ACTIONS)
def test_every_statement_granting_a_write_is_scoped_to_charge_rows_on_the_base_table(action):
    granting = [statement for statement in _statements() if action in granted_dynamodb_actions(statement)]
    assert granting, f"no statement grants {action}, so the clean-up gets AccessDenied"
    for statement in granting:
        assert _leading_keys(statement) == ["ACCOUNT#*"], f"{action} not scoped to ACCOUNT# rows:\n{statement}"
        assert '"ForAllValues:StringLike"' in statement, f"the ACCOUNT#* wildcard needs StringLike:\n{statement}"
        assert "/index/" not in statement, f"{action} should be base-table only:\n{statement}"


@pytest.mark.parametrize("action", WRITE_ACTIONS)
@pytest.mark.parametrize("pk", NON_CHARGE_PKS)
def test_non_charge_rows_cannot_be_written(action, pk):
    assert not _allows(action, pk), f"the clean-up role can {action} a row with pk {pk!r}"


@pytest.mark.parametrize("action", WRITE_ACTIONS)
def test_charge_rows_can_still_be_written(action):
    assert _allows(action, "ACCOUNT#westpac-altitude-qantas-black")
