"""WHIT-679: the hourly clean-up (transaction trigger) may only write to charge rows.

Delete and bulk save (BatchWriteItem can also delete) must sit in the ACCOUNT#*-scoped
statement, like UpdateItem since PR #621. Otherwise a bug in the clean-up could delete
CATEGORIES, RULE or device rows.
"""

import pytest
from _terraform import allows, granted_dynamodb_actions, leading_keys, policy_statements

POLICY = "transaction_trigger_dynamodb"
WRITE_ACTIONS = ("UpdateItem", "DeleteItem", "BatchWriteItem")
NON_CHARGE_PKS = ("CATEGORIES", "RULE", "DEVICE#abc", "FAILED#abc")


def test_the_unscoped_statements_grant_only_reads():
    unscoped = set()
    for statement in policy_statements(POLICY):
        if leading_keys(statement) is None:
            unscoped |= granted_dynamodb_actions(statement)
    assert unscoped == {"GetItem", "Query"}, f"unscoped trigger grants beyond reads: {sorted(unscoped)}"


@pytest.mark.parametrize("action", WRITE_ACTIONS)
def test_every_statement_granting_a_write_is_scoped_to_charge_rows_on_the_base_table(action):
    granting = [statement for statement in policy_statements(POLICY) if action in granted_dynamodb_actions(statement)]
    assert granting, f"no statement grants {action}, so the clean-up gets AccessDenied"
    for statement in granting:
        assert leading_keys(statement) == ["ACCOUNT#*"], f"{action} not scoped to ACCOUNT# rows:\n{statement}"
        assert '"ForAllValues:StringLike"' in statement, f"the ACCOUNT#* wildcard needs StringLike:\n{statement}"
        assert "/index/" not in statement, f"{action} should be base-table only:\n{statement}"


@pytest.mark.parametrize("action", WRITE_ACTIONS)
@pytest.mark.parametrize("pk", NON_CHARGE_PKS)
def test_non_charge_rows_cannot_be_written(action, pk):
    assert not allows(policy_statements(POLICY), action, pk), f"the clean-up role can {action} a row with pk {pk!r}"


@pytest.mark.parametrize("action", WRITE_ACTIONS)
def test_charge_rows_can_still_be_written(action):
    assert allows(policy_statements(POLICY), action, "ACCOUNT#westpac-altitude-qantas-black")
