"""WHIT-678 QA fix round 2: the rule-stamp clause added to find_identical_copy. Same fixtures as
test_pending_mirror_reissue_qa_fix.py (the REAL shared repo over FakeTable)."""

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

RUSH_OLD = "Pending - SP RUSHFASTERAU"
RUSH_NEW = "PENDING - SP RUSHFASTERAU"
GOGI_OLD = "Pending - GOGI MATCHA"
GOGI_NEW = "PENDING - GOGI MATCHA"

_SHARED_DIR = str(pathlib.Path(__file__).resolve().parents[2] / "shared")
_SHARED_MODULES = {path.stem for path in pathlib.Path(_SHARED_DIR).glob("*.py")} - {"ssm"}


@pytest.fixture
def layer():
    with use_condition_fields():
        sys.path.insert(0, _SHARED_DIR)
        saved = {name: sys.modules.pop(name, None) for name in _SHARED_MODULES | {"pending_mirror"}}
        try:
            yield (
                importlib.import_module("repository_transaction"),
                importlib.import_module("pending_mirror"),
                importlib.import_module("pending_carry"),
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
    repository._table = FakeTable()
    return repository


@pytest.fixture
def mirror(layer):
    return layer[1]


@pytest.fixture
def pending_carry(layer):
    return layer[2]


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


# [A20] (P0) Pure rule: a copy filed the same but by a rule is NOT identical to a hand-filed pending
# (and vice versa); the same stamp on both is.
def test_identical_copy_requires_the_same_rule_stamp(pending_carry, row):
    hand = row("old", GOGI_OLD, "-84.50", category="eatingout")
    ruled = row("new", GOGI_NEW, "-84.50", category="eatingout", filed_by_rule="rule-1")
    other_rule = row("new2", GOGI_NEW, "-84.50", category="eatingout", filed_by_rule="rule-2")

    assert pending_carry.find_identical_copy(hand, [ruled]) is None
    assert pending_carry.find_identical_copy(ruled, [hand]) is None
    assert pending_carry.find_identical_copy(ruled, [other_rule]) is None
    assert pending_carry.find_identical_copy(ruled, [hand, ruled | {"transaction_id": "x"}])["transaction_id"] == "x"


# [A21] (P0) Hand-filed + note on the stale copy, rule-filed same category on the re-issue → one row,
# the note moves across and the user owns the category (stamp cleared).
def test_a_noted_hand_filing_clears_the_rule_stamp_on_a_same_category_reissue(repo, mirror, row):
    repo._table.seed(
        row("old_rush", RUSH_OLD, "-192.00", category="shopping", notes="Patagonia Backpack"),
        row("new_rush", RUSH_NEW, "-192.00", category="shopping", filed_by_rule="rule-1"),
    )

    result = _run(mirror, repo, _bank("new_rush"))

    assert _ids(repo) == {"new_rush"}
    new = _stored(repo, "new_rush")
    assert (new["category"], new["notes"]) == ("shopping", "Patagonia Backpack")
    assert "filed_by_rule" not in new
    assert result["carried"] == 1


# [A22] (P1) Same rule stamp and same note on both copies → a plain delete, no write; the re-issue
# keeps its rule stamp.
def test_a_copy_with_the_same_rule_stamp_and_note_is_just_removed(repo, mirror, row):
    repo._table.seed(
        row("old_rush", RUSH_OLD, "-192.00", category="shopping", filed_by_rule="rule-1", notes="Backpack"),
        row("new_rush", RUSH_NEW, "-192.00", category="shopping", filed_by_rule="rule-1", notes="Backpack"),
    )

    result = _run(mirror, repo, _bank("new_rush"))

    assert _ids(repo) == {"new_rush"}
    assert _stored(repo, "new_rush")["filed_by_rule"] == "rule-1"
    assert (result["removed"], result["carried"]) == (1, 0)
