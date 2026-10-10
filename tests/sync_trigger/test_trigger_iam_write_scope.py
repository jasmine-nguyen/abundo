"""WHIT-679: the hourly clean-up (transaction trigger) may only write to charge rows.

Delete and bulk save (BatchWriteItem can also delete) must sit in the ACCOUNT#*-scoped
statement, like UpdateItem since PR #621. Otherwise a bug in the clean-up could delete
CATEGORIES, RULE or device rows.
"""

import importlib
from decimal import Decimal

import pytest
from _dynamo_fakes import FakeTable
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
@pytest.mark.parametrize("pk", NON_CHARGE_PKS)
def test_non_charge_rows_cannot_be_written(action, pk):
    assert not allows(policy_statements(POLICY), action, pk), f"the clean-up role can {action} a row with pk {pk!r}"


# Every account's charge rows stay deletable and bulk-saveable.
@pytest.mark.parametrize("action", ("DeleteItem", "BatchWriteItem"))
def test_every_account_rows_pk_is_inside_the_write_scope(layer, action):
    repository_transaction = layer[0]
    constants = importlib.import_module("constants")
    repository = repository_transaction.TransactionRepository()
    repository._table = FakeTable()
    repository.insert_transactions([
        {"transaction_id": f"t-{account_id}", "account_id": account_id, "date": "2026-09-30",
         "amount": Decimal("-1"), "status": "pending"}
        for account_id in constants.ACCOUNT_ID_MAP.values()
    ])

    pks = {key[0] for key in repository._table.store}
    assert len(pks) == len(constants.ACCOUNT_ID_MAP)
    for pk in pks:
        assert allows(policy_statements(POLICY), action, pk), f"the trigger role can't {action} a row with pk {pk!r}"


# The reads keep the date-index: the mirror lists an account's rows over it.
def test_reads_still_reach_the_date_index():
    granting = [s for s in policy_statements(POLICY) if "Query" in granted_dynamodb_actions(s)]
    assert granting, "no statement grants Query"
    assert any("/index/*" in statement for statement in granting), "Query lost the index/* resource"
