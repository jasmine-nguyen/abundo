"""WHIT-678-perm QA: the transaction-trigger role, enforced against the pending mirror's real calls.

The static guard (test_trigger_iam_dynamodb_actions.py) proves the needed verbs are granted
somewhere in the policy. These tests read the policy per statement and play the WHIT-678 live
incident (Cettire + SP RUSHFASTERAU) through a FakeTable that refuses, with AccessDenied, any
call the trigger policy in terraform/iam.tf would refuse, including the LeadingKeys scope.
"""

import importlib
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
from _terraform import DYNAMODB_VERB_TO_ACTION, allows, policy_statements

POLICY = "transaction_trigger_dynamodb"


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


def _row(transaction_id, description, amount, day="2026-09-30", **fields):
    return {
        "pk": f"ACCOUNT#{WESTPAC}",
        "sk": f"TXN#{transaction_id}",
        "transaction_id": transaction_id,
        "account_id": WESTPAC,
        "date": day,
        "amount": Decimal(amount),
        "description": description,
        "merchant_name": "",
        "status": "pending",
        "category": "Unfiled",
        **fields,
    }


_is_unfiled = unfiled_except("shopping", "clothing")


def _seed_rush_and_cettire(repo, merchant):
    rows = [
        _row("old_cettire", CETTIRE_OLD, "-260.36", category="shopping", notes="The North Face Jacket"),
        _row("new_cettire", CETTIRE_NEW, "-260.36", category="shopping", filed_by_rule="rule-1"),
        _row("old_rush", RUSH_OLD, "-192.00", day="2026-09-29", category="shopping", notes="Patagonia Backpack"),
        _row("new_rush", RUSH_NEW, "-192.00", category="shopping", filed_by_rule="rule-1"),
    ]
    for row in rows:
        row["merchant_name"] = merchant.clean_merchant(row["description"], "")
    repo._table.seed(*rows)


# [A1] P0 — the live incident, replayed under the trigger role's real policy.
def test_the_rush_and_cettire_doubles_are_removed_with_notes_kept_under_the_trigger_policy(layer, repo):
    _, mirror = layer
    _seed_rush_and_cettire(repo, importlib.import_module("merchant"))
    bank = reissue_bank_rows("new_cettire", "new_rush")

    result = run_mirror(mirror, repo, bank, _is_unfiled, REISSUE_TODAY)

    assert result["failed"] == 0, f"a call was refused by the trigger policy (AccessDenied): {result}"
    assert result["carried"] == 2
    keys = {key[1] for key in repo._table.store}
    assert keys == {"TXN#new_cettire", "TXN#new_rush"}
    assert repo._table.store[(f"ACCOUNT#{WESTPAC}", "TXN#new_cettire")]["notes"] == "The North Face Jacket"
    assert repo._table.store[(f"ACCOUNT#{WESTPAC}", "TXN#new_rush")]["notes"] == "Patagonia Backpack"


# [A5] P1 — the mirror's category read succeeds under the trigger policy and never writes.
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
