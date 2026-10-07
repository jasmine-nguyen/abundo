"""QA edges for the webhook dropping user-deleted charges (WHIT-654).

REAL process_transaction over the webhook's REAL TransactionRepository and a FakeTable.
"""
from functools import partial

from _budget_endpoint_fakes import _FakeCategoryRepo
from _rule_ingest_fakes import FakeRuleStore

_MAPPED_ACCOUNT = "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0"
_ACCOUNT_PK = "ACCOUNT#anz-rewards-black-visa"


_Categories = partial(_FakeCategoryRepo, [{"id": "subscriptions"}])


def _raw(txn_id, *, pending, pending_id=None, account=_MAPPED_ACCOUNT):
    return {"id": txn_id, "date": "2026-09-27", "authorizedDate": "2026-09-27",
            "description": "ANTHROPIC* CLAUDE SUB", "merchantName": "Anthropic",
            "amount": -170.01, "accountId": account, "accountName": "ANZ Rewards",
            "category": None, "pending": pending, "type": "PAYMENT",
            "pendingTransactionId": pending_id}


def _charge_rows(repo):
    return {sk for (pk, sk) in repo._table.store if pk == _ACCOUNT_PK}


def _setup(lam, monkeypatch):
    monkeypatch.setattr(lam.handler, "RuleRepository", FakeRuleStore)
    monkeypatch.setattr(lam.handler, "CategoryRepository", _Categories)
    return lam.handler


# [A11]
def test_a_delivery_of_only_deleted_charges_writes_nothing(lam, repo, monkeypatch):
    handler = _setup(lam, monkeypatch)
    handler.process_transaction({"id": "e1", "data": [_raw("dup", pending=True)]}, repo)
    repo.delete_transaction(_ACCOUNT_PK, "TXN#dup")

    handler.process_transaction({"id": "e2", "data": [_raw("dup", pending=True)]}, repo)
    handler.process_transaction({"id": "e3", "data": [_raw("dup", pending=True)]}, repo)

    assert _charge_rows(repo) == set()


# [A12]
def test_deleting_a_pending_still_lets_its_settled_charge_land(lam, repo, monkeypatch):
    handler = _setup(lam, monkeypatch)
    handler.process_transaction({"id": "e1", "data": [_raw("p1", pending=True)]}, repo)
    repo.delete_transaction(_ACCOUNT_PK, "TXN#p1")

    # The bank settles it: a new posted id pointing back at the deleted pending, plus a re-send.
    handler.process_transaction(
        {"id": "e2", "data": [_raw("p1", pending=True), _raw("posted-1", pending=False, pending_id="p1")]},
        repo)

    assert _charge_rows(repo) == {"TXN#posted-1"}


# [A13]
def test_an_unmapped_account_charge_still_goes_to_failed_not_the_filter(lam, repo, monkeypatch):
    handler = _setup(lam, monkeypatch)
    handler.process_transaction(
        {"id": "e1", "data": [_raw("x", pending=False, account="unknown-account")]}, repo)
    assert any(pk == "FAILED" for (pk, _sk) in repo._table.store)


# [A14]
def test_the_filter_reads_the_marker_the_api_delete_writes(lam, repo, monkeypatch):
    handler = _setup(lam, monkeypatch)
    handler.process_transaction({"id": "e1", "data": [_raw("dup", pending=False)]}, repo)
    repo.delete_transaction(_ACCOUNT_PK, "TXN#dup")
    marker_keys = [key for key in repo._table.store if key[0].startswith("DELETED#")]
    assert marker_keys == [(f"DELETED#{_ACCOUNT_PK}", "TXN#dup")]

    repo._table.get_item_keys.clear()
    handler.process_transaction({"id": "e2", "data": [_raw("dup", pending=False)]}, repo)
    assert {"pk": f"DELETED#{_ACCOUNT_PK}", "sk": "TXN#dup"} in repo._table.get_item_keys
    assert _charge_rows(repo) == set()
