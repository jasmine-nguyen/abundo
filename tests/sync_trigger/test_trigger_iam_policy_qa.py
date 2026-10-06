"""WHIT-678-perm QA: the transaction-trigger role, enforced against the pending mirror's real calls.

The static guard (test_trigger_iam_dynamodb_actions.py) proves the needed verbs are granted
somewhere in the policy. These tests read the policy per statement and play the WHIT-678 live
incident (Cettire + SP RUSHFASTERAU) through a FakeTable that refuses, with AccessDenied, any
call the trigger policy in terraform/iam.tf would refuse, including the LeadingKeys scope.
"""

import copy
import importlib
import pathlib
import sys
from datetime import date
from decimal import Decimal

import pytest
from _boto_stubs import install_import_satisfiers, use_condition_fields
from _dynamo_fakes import FakeTable, _client_error
from _terraform import DYNAMODB_VERB_TO_ACTION, allows, policy_statements

install_import_satisfiers()

WESTPAC_AID = "A3AC9195-9E8D-48B8-86D0-46D130D7F64A"
WESTPAC_SOURCE = {"bid": "fiskil_77", "aid": WESTPAC_AID}
WESTPAC = "westpac-altitude-qantas-black"
TODAY = date(2026, 10, 1)

_SHARED_DIR = str(pathlib.Path(__file__).resolve().parents[2] / "shared")
_SHARED_MODULES = {path.stem for path in pathlib.Path(_SHARED_DIR).glob("*.py")} - {"ssm"}

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
def layer():
    with use_condition_fields():
        sys.path.insert(0, _SHARED_DIR)
        saved = {name: sys.modules.pop(name, None) for name in _SHARED_MODULES | {"pending_mirror"}}
        try:
            yield (
                importlib.import_module("repository_transaction"),
                importlib.import_module("pending_mirror"),
                importlib.import_module("repository_category"),
            )
        finally:
            for name, module in saved.items():
                sys.modules.pop(name, None)
                if module is not None:
                    sys.modules[name] = module
            sys.path.remove(_SHARED_DIR)


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


def _is_unfiled(category):
    return category not in ("shopping", "clothing")


def _seed_rush_and_cettire(repo, merchant):
    rows = [
        _row("old_cettire", "Pending - Cettire          ", "-260.36", category="shopping", notes="The North Face Jacket"),
        _row("new_cettire", "PENDING - Cettire           ", "-260.36", category="shopping", filed_by_rule="rule-1"),
        _row("old_rush", "Pending - SP RUSHFASTERAU", "-192.00", day="2026-09-29", category="shopping",
             notes="Patagonia Backpack"),
        _row("new_rush", "PENDING - SP RUSHFASTERAU", "-192.00", category="shopping", filed_by_rule="rule-1"),
    ]
    for row in rows:
        row["merchant_name"] = merchant.clean_merchant(row["description"], "")
    repo._table.seed(*rows)


def _bank(*ids):
    return [{"id": transaction_id, "accountId": WESTPAC_AID, "pending": True, "date": "2026-09-30"}
            for transaction_id in ids]


# [A1] P0 — the live incident, replayed under the trigger role's real policy.
def test_the_rush_and_cettire_doubles_are_removed_with_notes_kept_under_the_trigger_policy(layer, repo):
    _, mirror, _ = layer
    _seed_rush_and_cettire(repo, importlib.import_module("merchant"))
    bank = _bank("new_cettire", "new_rush")

    result = mirror.mirror_account(repo, lambda *args: copy.deepcopy(bank), WESTPAC_SOURCE, TODAY, _is_unfiled)

    assert result["failed"] == 0, f"a call was refused by the trigger policy (AccessDenied): {result}"
    assert result["carried"] == 2
    keys = {key[1] for key in repo._table.store}
    assert keys == {"TXN#new_cettire", "TXN#new_rush"}
    assert repo._table.store[(f"ACCOUNT#{WESTPAC}", "TXN#new_cettire")]["notes"] == "The North Face Jacket"
    assert repo._table.store[(f"ACCOUNT#{WESTPAC}", "TXN#new_rush")]["notes"] == "Patagonia Backpack"


# [A5] P1 — with the backfill denied, the mirror's category read still fails open.
def test_the_category_read_still_succeeds_when_its_backfill_is_denied(layer):
    _, _, repository_category = layer
    pending_carry = importlib.import_module("pending_carry")
    category_repo = repository_category.CategoryRepository()
    table = _enforce_trigger_policy(FakeTable())
    unslotted = {
        cat_id: {key: value for key, value in category.items() if key != "colorSlot"}
        for cat_id, category in repository_category.SEED_CATEGORIES.items()
    }
    table.seed({"pk": "CATEGORIES", "sk": "CATEGORIES", "items": unslotted, "version": Decimal(1)})
    category_repo._table = table

    is_unfiled = pending_carry.load_is_unfiled(category_repo)

    assert table.update_keys, "the store should need a backfill, so the denied write is attempted"
    assert is_unfiled("not-a-category")
    assert not is_unfiled(next(iter(repository_category.SEED_CATEGORIES)))
