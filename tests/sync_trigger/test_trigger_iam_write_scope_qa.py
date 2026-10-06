"""WHIT-679 QA: the clean-up's deletes and bulk saves, run against the trigger role's real policy.

Reuses the WHIT-678 policy enforcer (test_trigger_iam_policy_qa.py): a FakeTable that answers
AccessDenied to any call terraform/iam.tf's transaction_trigger_dynamodb would refuse.
"""

import importlib
import importlib.util
import pathlib
from datetime import datetime, timezone
from decimal import Decimal

import pytest
from _dynamo_fakes import FakeTable
from _pending_mirror_fakes import reissue_bank_rows, run_reissue
from _terraform import allows, granted_dynamodb_actions, policy_statements

_spec = importlib.util.spec_from_file_location(
    "trigger_iam_policy_qa", pathlib.Path(__file__).with_name("test_trigger_iam_policy_qa.py")
)
policy_qa = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(policy_qa)

repo = policy_qa.repo

NON_CHARGE_ROWS = (
    {"pk": "CATEGORIES", "sk": "CATEGORIES", "status": "pending"},
    {"pk": "RULE", "sk": "RULE#rule-1", "status": "pending"},
    {"pk": "DEVICE#abc", "sk": "TOKEN", "status": "pending"},
    {"pk": "FAILED", "sk": "TXN#x", "status": "pending"},
)


# [A1] P0 — the plain delete path (a pending the bank dropped, no user edit) still works.
def test_a_dropped_unedited_pending_is_still_deleted_under_the_trigger_policy(layer, repo):
    _, mirror = layer
    repo._table.seed(policy_qa._row("gone", "PENDING - Coles", "-12.00", category="Unfiled"))
    bank = reissue_bank_rows("still-there")

    result = run_reissue(mirror, repo, bank, policy_qa._is_unfiled)

    assert result["failed"] == 0, f"the delete was refused by the trigger policy: {result}"
    assert result["removed"] == 1
    assert repo._table.store == {}


# [A2] P0 — a buggy delete aimed at a non-charge row is refused and the row survives.
@pytest.mark.parametrize("row", NON_CHARGE_ROWS, ids=lambda row: row["pk"])
def test_deleting_a_non_charge_row_is_refused_and_the_row_survives(repo, row):
    database_error = importlib.import_module("repository_errors").DatabaseError
    repo._table.seed(row)

    with pytest.raises(database_error):
        repo.delete_if_still_pending(row["pk"], row["sk"])

    assert (row["pk"], row["sk"]) in repo._table.store


# [A3] P0 — the bulk-save path can't write a non-charge row (the failed-charges list here).
def test_bulk_saving_a_non_charge_row_is_refused(repo):
    database_error = importlib.import_module("repository_errors").DatabaseError

    with pytest.raises(database_error):
        repo.save_failed_transactions([
            {"transaction_id": "x", "error": "boom", "failed_at": datetime.now(timezone.utc).isoformat()}
        ])

    assert repo._table.store == {}


# [A4] P1 — every account's charge rows stay deletable and bulk-saveable.
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
        assert allows(policy_statements(policy_qa.POLICY), action, pk), f"the trigger role can't {action} a row with pk {pk!r}"


# [A5] P1 — the reads keep the date-index: the mirror lists an account's rows over it.
def test_reads_still_reach_the_date_index():
    granting = [s for s in policy_statements(policy_qa.POLICY) if "Query" in granted_dynamodb_actions(s)]
    assert granting, "no statement grants Query"
    assert any("/index/*" in statement for statement in granting), "Query lost the index/* resource"
