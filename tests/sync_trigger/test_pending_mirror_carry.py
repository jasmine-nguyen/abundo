"""WHIT-663: the hourly pending mirror moves a user's edit onto the settled charge straight away.

An edited pending the bank no longer lists → its edit is copied onto its settled twin and the
pending is removed, in the same run. No twin yet → the pending is kept for next hour.

Runs the REAL shared TransactionRepository over the in-memory FakeTable, like
test_pending_mirror.py.
"""

import copy
import importlib
import pathlib
import sys
from datetime import date
from decimal import Decimal

import pytest

from _boto_stubs import install_import_satisfiers, use_condition_fields
from _dynamo_fakes import FakeTable

install_import_satisfiers(ssm_default="test-api-key")

WESTPAC_AID = "A3AC9195-9E8D-48B8-86D0-46D130D7F64A"
WESTPAC_SOURCE = {"bid": "fiskil_77", "aid": WESTPAC_AID}
WESTPAC = "westpac-altitude-qantas-black"
TODAY = date(2026, 9, 29)

_SHARED_DIR = str(pathlib.Path(__file__).resolve().parents[2] / "shared")
_SHARED_MODULES = {path.stem for path in pathlib.Path(_SHARED_DIR).glob("*.py")} - {"ssm"}


@pytest.fixture
def layer():
    with use_condition_fields():
        sys.path.insert(0, _SHARED_DIR)
        saved = {name: sys.modules.pop(name, None) for name in _SHARED_MODULES | {"pending_mirror"}}
        try:
            yield importlib.import_module("repository_transaction"), importlib.import_module("pending_mirror")
        finally:
            for name, module in saved.items():
                sys.modules.pop(name, None)
                if module is not None:
                    sys.modules[name] = module
            sys.path.remove(_SHARED_DIR)


@pytest.fixture
def repo(layer):
    repository_transaction, _ = layer
    repository = repository_transaction.TransactionRepository()
    repository._table = FakeTable()
    return repository


@pytest.fixture
def mirror(layer):
    return layer[1]


def _row(transaction_id, day="2026-09-28", status="pending", **fields):
    return {
        "pk": f"ACCOUNT#{WESTPAC}",
        "sk": f"TXN#{transaction_id}",
        "transaction_id": transaction_id,
        "account_id": WESTPAC,
        "date": day,
        "amount": Decimal("-10.00"),
        "description": f"SHOP {transaction_id}",
        "status": status,
        "category": "Unfiled",
        **fields,
    }


def _bank(*ids):
    return [{"id": transaction_id, "accountId": WESTPAC_AID, "pending": True, "date": "2026-09-28"}
            for transaction_id in ids]


def _fetch_returning(rows):
    def fetch(*args):
        return copy.deepcopy(rows)
    return fetch


def _ids(repo):
    return {key[1].removeprefix("TXN#") for key in repo._table.store}


def _stored(repo, transaction_id):
    return repo._table.store[(f"ACCOUNT#{WESTPAC}", f"TXN#{transaction_id}")]


def _is_unfiled(category):
    return category not in ("groceries",)


def test_an_edited_pending_the_bank_dropped_moves_its_edit_onto_the_settled_charge(repo, mirror):
    guzman = {
        "amount": Decimal("-23.50"),
        "merchant_name": "Guzman y Gomez",
        "description": "GUZMAN Y GOMEZ NEWTOWN",
    }
    repo._table.seed(
        _row("listed"),
        # The user filed and noted this pending; the bank has since settled it as "settled".
        _row("edited", day="2026-09-27", category="groceries", notes="dinner with Sam", **guzman),
        _row("settled", status="posted", **guzman),
        # Edited too, but its settled charge hasn't arrived yet.
        _row("waiting", notes="gift for Mum"),
    )
    bank = _bank("listed") + [{"id": "settled", "accountId": WESTPAC_AID, "pending": False}]

    result = mirror.mirror_account(repo, _fetch_returning(bank), WESTPAC_SOURCE, TODAY, _is_unfiled)

    assert _ids(repo) == {"listed", "settled", "waiting"}
    settled = _stored(repo, "settled")
    assert settled["status"] == "posted"
    assert settled["category"] == "groceries"
    assert settled["notes"] == "dinner with Sam"
    assert _stored(repo, "waiting")["notes"] == "gift for Mum"
    assert result["carried"] == 1
    assert result["kept"] == 1
    assert result["removed"] == 0
    assert result["failed"] == 0
