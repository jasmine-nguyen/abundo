"""WHIT-678 QA fix round: the re-issued-copy rules added by the fix (find_reissued_twin's
"already filed the same" clause, and the identical-copy check now running first). Same fixtures
as test_pending_mirror_reissue_qa.py (the REAL shared repo over FakeTable)."""

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
TODAY = date(2026, 10, 1)

CETTIRE_OLD = "Pending - Cettire          "
CETTIRE_NEW = "PENDING - Cettire           "
RUSH_OLD = "Pending - SP RUSHFASTERAU"
RUSH_NEW = "PENDING - SP RUSHFASTERAU"

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
    repository = layer[0].TransactionRepository()
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


def _bank(*ids):
    return [{"id": transaction_id, "accountId": WESTPAC_AID, "pending": True, "date": "2026-09-30"}
            for transaction_id in ids]


def _ids(repo):
    return {key[1].removeprefix("TXN#") for key in repo._table.store}


def _stored(repo, transaction_id):
    return repo._table.store[(f"ACCOUNT#{WESTPAC}", f"TXN#{transaction_id}")]


def _is_unfiled(category):
    return category not in ("shopping", "clothing", "eatingout", "transport")


def _run(mirror, repo, bank):
    def fetch(*args):
        return copy.deepcopy(bank)
    return mirror.mirror_account(repo, fetch, WESTPAC_SOURCE, TODAY, _is_unfiled)


GOGI_OLD = "Pending - GOGI MATCHA"
GOGI_NEW = "PENDING - GOGI MATCHA"


# [A15] (P0) The user hand-picked the old copy's category; the bank's re-issue got the SAME category
# from a rule. One row must remain AND the user must still own the category (no rule stamp) — a
# stamp lets a later rule edit/delete re-file or clear the user's choice (rule_book reconcile).
def test_a_hand_filed_category_stays_user_owned_when_the_reissue_is_rule_filed_the_same(repo, mirror, row):
    repo._table.seed(
        row("old_gogi", GOGI_OLD, "-84.50", category="eatingout"),
        row("new_gogi", GOGI_NEW, "-84.50", category="eatingout", filed_by_rule="rule-1"),
    )

    _run(mirror, repo, _bank("new_gogi"))

    assert _ids(repo) == {"new_gogi"}
    assert _stored(repo, "new_gogi")["category"] == "eatingout"
    assert "filed_by_rule" not in _stored(repo, "new_gogi")


# [A16] (P1) Old hand-filed + note, re-issue hand-filed the same category with no note → nothing
# clashes, the note moves onto the re-issue and one row remains.
def test_a_note_moves_onto_a_reissue_hand_filed_the_same(repo, mirror, row):
    repo._table.seed(
        row("old_rush", RUSH_OLD, "-192.00", category="shopping", notes="Patagonia Backpack"),
        row("new_rush", RUSH_NEW, "-192.00", category="shopping"),
    )

    result = _run(mirror, repo, _bank("new_rush"))

    assert _ids(repo) == {"new_rush"}
    new = _stored(repo, "new_rush")
    assert new["notes"] == "Patagonia Backpack"
    assert new["category"] == "shopping"
    assert result["carried"] == 1


# [A17] (P1) Old rule-filed + note; the rule missed the re-issue (unfiled) → the category, its rule
# stamp and the note all move across.
def test_a_rule_filed_note_moves_onto_an_unfiled_reissue_with_its_stamp(repo, mirror, row):
    repo._table.seed(
        row("old_rush", RUSH_OLD, "-192.00", category="shopping", filed_by_rule="rule-1", notes="Backpack"),
        row("new_rush", RUSH_NEW, "-192.00"),
    )

    result = _run(mirror, repo, _bank("new_rush"))

    assert _ids(repo) == {"new_rush"}
    new = _stored(repo, "new_rush")
    assert (new["category"], new["filed_by_rule"], new["notes"]) == ("shopping", "rule-1", "Backpack")
    assert result["carried"] == 1


# [A18] (P1) Old rule-filed + note, TWO live copies filed by the same rule → ambiguous, both kept
# (exactly-one rule), nothing written.
def test_two_rule_filed_reissues_are_ambiguous_and_nothing_moves(repo, mirror, row):
    repo._table.seed(
        row("old_rush", RUSH_OLD, "-192.00", category="shopping", filed_by_rule="rule-1", notes="Backpack"),
        row("new_a", RUSH_NEW, "-192.00", category="shopping", filed_by_rule="rule-1"),
        row("new_b", RUSH_NEW, "-192.00", day="2026-09-29", category="shopping", filed_by_rule="rule-1"),
    )

    result = _run(mirror, repo, _bank("new_a", "new_b"))

    assert _ids(repo) == {"old_rush", "new_a", "new_b"}
    assert "notes" not in _stored(repo, "new_a")
    assert "notes" not in _stored(repo, "new_b")
    assert result["kept"] == 1


# [A19] (P1) Old rule-filed + note, re-issue filed by a DIFFERENT rule into another category →
# a rule never overrides another rule: kept, re-issue untouched.
def test_a_reissue_filed_by_another_rule_differently_is_left_alone(repo, mirror, row):
    repo._table.seed(
        row("old_rush", RUSH_OLD, "-192.00", category="shopping", filed_by_rule="rule-1", notes="Backpack"),
        row("new_rush", RUSH_NEW, "-192.00", category="clothing", filed_by_rule="rule-2"),
    )

    result = _run(mirror, repo, _bank("new_rush"))

    assert _ids(repo) == {"old_rush", "new_rush"}
    new = _stored(repo, "new_rush")
    assert (new["category"], new["filed_by_rule"]) == ("clothing", "rule-2")
    assert "notes" not in new
    assert result["kept"] == 1
