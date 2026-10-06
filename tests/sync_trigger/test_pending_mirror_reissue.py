"""WHIT-678: the bank re-issues a still-pending charge under a new id when its description text
changes ("Pending - Cettire" → "PENDING - Cettire"). The hourly pending mirror must leave ONE
row per purchase, keeping the user's edit, instead of keeping the edited stale copy forever.

Runs the REAL shared TransactionRepository over the in-memory FakeTable, like
test_pending_mirror_carry.py.
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

install_import_satisfiers()

WESTPAC_AID = "A3AC9195-9E8D-48B8-86D0-46D130D7F64A"
WESTPAC_SOURCE = {"bid": "fiskil_77", "aid": WESTPAC_AID}
WESTPAC = "westpac-altitude-qantas-black"
TODAY = date(2026, 10, 1)

CETTIRE_OLD = "Pending - Cettire          "
CETTIRE_NEW = "PENDING - Cettire           "
RUSH_OLD = "Pending - SP RUSHFASTERAU"
RUSH_NEW = "PENDING - SP RUSHFASTERAU"
MYKI_OLD = "Pending - myki"
MYKI_NEW = "PENDING - myki"

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


@pytest.fixture
def row(layer):
    clean_merchant = importlib.import_module("merchant").clean_merchant

    def make(transaction_id, description, amount, day="2026-09-30", status="pending", **fields):
        return {
            "pk": f"ACCOUNT#{WESTPAC}",
            "sk": f"TXN#{transaction_id}",
            "transaction_id": transaction_id,
            "account_id": WESTPAC,
            "date": day,
            "amount": Decimal(amount),
            "description": description,
            "merchant_name": clean_merchant(description, ""),
            "status": status,
            "category": "Unfiled",
            **fields,
        }
    return make


def _bank(*ids, pending=True):
    return [{"id": transaction_id, "accountId": WESTPAC_AID, "pending": pending, "date": "2026-09-30"}
            for transaction_id in ids]


def _fetch_returning(rows, before_return=None):
    def fetch(*args):
        if before_return is not None:
            before_return()
        return copy.deepcopy(rows)
    return fetch


def _ids(repo):
    return {key[1].removeprefix("TXN#") for key in repo._table.store}


def _stored(repo, transaction_id):
    return repo._table.store[(f"ACCOUNT#{WESTPAC}", f"TXN#{transaction_id}")]


def _is_unfiled(category):
    return category not in ("shopping", "clothing", "eatingout", "transport")


def _run(mirror, repo, bank, before_return=None):
    return mirror.mirror_account(repo, _fetch_returning(bank, before_return), WESTPAC_SOURCE, TODAY, _is_unfiled)


def test_a_reissued_pending_takes_the_users_edit_and_the_stale_copy_is_removed(repo, mirror, row):
    repo._table.seed(
        row("old_cettire", CETTIRE_OLD, "-260.36", category="shopping", notes="The North Face Jacket"),
        row("new_cettire", CETTIRE_NEW, "-260.36", category="shopping", filed_by_rule="rule-1"),
        row("old_rush", RUSH_OLD, "-192.00", day="2026-09-29", category="shopping", notes="Patagonia Backpack"),
        row("new_rush", RUSH_NEW, "-192.00", category="shopping", filed_by_rule="rule-1"),
    )

    result = _run(mirror, repo, _bank("new_cettire", "new_rush"))

    assert _ids(repo) == {"new_cettire", "new_rush"}
    cettire = _stored(repo, "new_cettire")
    assert cettire["status"] == "pending"
    assert cettire["category"] == "shopping"
    assert cettire["notes"] == "The North Face Jacket"
    assert "filed_by_rule" not in cettire
    rush = _stored(repo, "new_rush")
    assert rush["notes"] == "Patagonia Backpack"
    assert "filed_by_rule" not in rush
    assert result["carried"] == 2
    assert result["kept"] == 0
    assert result["failed"] == 0


def test_a_stale_copy_identical_to_the_reissued_pending_is_removed(repo, mirror, row):
    repo._table.seed(
        row("old_myki", MYKI_OLD, "-1.00", category="transport"),
        row("new_myki", MYKI_NEW, "-1.00", category="transport"),
        row("old_gogi", "Pending - Gogi Matcha", "-84.50", category="eatingout"),
        row("new_gogi", "PENDING - Gogi Matcha", "-84.50", category="eatingout"),
    )

    result = _run(mirror, repo, _bank("new_myki", "new_gogi"))

    assert _ids(repo) == {"new_myki", "new_gogi"}
    assert _stored(repo, "new_myki")["category"] == "transport"
    assert _stored(repo, "new_gogi")["category"] == "eatingout"
    assert result["kept"] == 0
    assert result["failed"] == 0
    assert result["removed"] + result["carried"] == 2


def test_clashing_hand_filed_categories_keep_both_copies(repo, mirror, row):
    repo._table.seed(
        row("old_cettire", CETTIRE_OLD, "-260.36", category="shopping"),
        row("new_cettire", CETTIRE_NEW, "-260.36", category="clothing"),
    )

    result = _run(mirror, repo, _bank("new_cettire"))

    assert _ids(repo) == {"old_cettire", "new_cettire"}
    assert _stored(repo, "old_cettire")["category"] == "shopping"
    assert _stored(repo, "new_cettire")["category"] == "clothing"
    assert result["kept"] == 1
    assert result["carried"] == 0
    assert result["removed"] == 0


def test_two_possible_replacements_and_no_exact_copy_keep_the_edited_pending(repo, mirror, row):
    repo._table.seed(
        row("old_rush", RUSH_OLD, "-192.00", category="shopping", notes="Patagonia Backpack"),
        row("new_rush_a", RUSH_NEW, "-192.00"),
        row("new_rush_b", RUSH_NEW, "-192.00", day="2026-09-29"),
    )

    result = _run(mirror, repo, _bank("new_rush_a", "new_rush_b"))

    assert _ids(repo) == {"old_rush", "new_rush_a", "new_rush_b"}
    assert "notes" not in _stored(repo, "new_rush_a")
    assert "notes" not in _stored(repo, "new_rush_b")
    assert result["kept"] == 1
    assert result["carried"] == 0


@pytest.mark.parametrize("new_day, new_amount", [("2026-09-25", "-260.36"), ("2026-09-30", "-260.00")])
def test_a_replacement_too_far_apart_or_for_another_amount_keeps_the_edited_pending(
    repo, mirror, row, new_day, new_amount,
):
    repo._table.seed(
        row("old_cettire", CETTIRE_OLD, "-260.36", day="2026-09-30", category="shopping", notes="Jacket"),
        row("new_cettire", CETTIRE_NEW, new_amount, day=new_day),
    )

    result = _run(mirror, repo, _bank("new_cettire"))

    assert _ids(repo) == {"old_cettire", "new_cettire"}
    assert "notes" not in _stored(repo, "new_cettire")
    assert result["kept"] == 1


def test_a_settled_twin_wins_over_a_live_pending_copy(repo, mirror, row):
    repo._table.seed(
        row("old_rush", RUSH_OLD, "-192.00", category="shopping", notes="Patagonia Backpack"),
        row("settled_rush", "SP RUSHFASTERAU SYDNEY AU", "-192.00", status="posted", merchant_name="SP RUSHFASTERAU"),
        row("other_rush", RUSH_NEW, "-192.00"),
    )
    bank = _bank("other_rush") + _bank("settled_rush", pending=False)

    result = _run(mirror, repo, bank)

    assert _ids(repo) == {"settled_rush", "other_rush"}
    settled = _stored(repo, "settled_rush")
    assert settled["category"] == "shopping"
    assert settled["notes"] == "Patagonia Backpack"
    other = _stored(repo, "other_rush")
    assert other["category"] == "Unfiled"
    assert "notes" not in other
    assert result["carried"] == 1


def test_a_replacement_deleted_mid_run_is_never_resurrected(repo, mirror, row):
    repo._table.seed(
        row("old_cettire", CETTIRE_OLD, "-260.36", category="shopping", notes="The North Face Jacket"),
        row("new_cettire", CETTIRE_NEW, "-260.36", category="shopping", filed_by_rule="rule-1"),
    )

    def delete_replacement():
        del repo._table.store[(f"ACCOUNT#{WESTPAC}", "TXN#new_cettire")]

    result = _run(mirror, repo, _bank("new_cettire"), before_return=delete_replacement)

    assert _ids(repo) == {"old_cettire"}
    assert _stored(repo, "old_cettire")["notes"] == "The North Face Jacket"
    assert result["carried"] == 0
    assert result["removed"] == 0
