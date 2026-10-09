"""A charge the user deleted must not come back through a BankSync re-send (WHIT-654).

BankSync re-sends each charge for 7 days. Without the "deleted by you" marker, the webhook's
reconcile turns the re-send into an insert and the charge reappears. Driven through
process_transaction with the webhook's REAL TransactionRepository over a FakeTable; the delete is
the shared repository's own delete_transaction (the one the app's DELETE route uses), inherited by
the webhook repository.
"""

from _rule_ingest_fakes import FakeRuleStore, SubscriptionCategories


_MAPPED_ACCOUNT = "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0"
_ACCOUNT_PK = "ACCOUNT#anz-rewards-black-visa"


def _raw(txn_id, *, pending, pending_id=None, account=_MAPPED_ACCOUNT):
    return {"id": txn_id, "date": "2026-09-27", "authorizedDate": "2026-09-27",
            "description": "ANTHROPIC* CLAUDE SUB", "merchantName": "Anthropic",
            "amount": -170.01, "accountId": account, "accountName": "ANZ Rewards",
            "category": None, "pending": pending, "type": "PAYMENT",
            "pendingTransactionId": pending_id}


def _stored_charge(repo, txn_id):
    return repo._table.store.get((_ACCOUNT_PK, f"TXN#{txn_id}"))


def _charge_rows(repo):
    return {sk for (pk, sk) in repo._table.store if pk == _ACCOUNT_PK}


def _setup(lam, monkeypatch):
    monkeypatch.setattr(lam.handler, "RuleRepository", FakeRuleStore)
    monkeypatch.setattr(lam.handler, "CategoryRepository", SubscriptionCategories)
    return lam.handler


def test_a_deleted_charge_resent_by_the_bank_is_not_saved_again(lam, repo, monkeypatch):
    handler = _setup(lam, monkeypatch)

    seen_by_rules = []
    real_apply = handler.rule_ingest.apply

    def recording_apply(transactions, **kwargs):
        seen_by_rules.extend(t["transaction_id"] for t in transactions)
        return real_apply(transactions, **kwargs)

    monkeypatch.setattr(handler.rule_ingest, "apply", recording_apply)

    seen_by_alerts = []

    def recording_capture(transactions, **kwargs):
        seen_by_alerts.extend(t["transaction_id"] for t in transactions)
        return None

    monkeypatch.setattr(handler.budget_alerts, "capture_pre_write", recording_capture)

    # The stale pending and a posted charge are stored, then the user deletes both.
    handler.process_transaction(
        {"id": "evt-1", "data": [_raw("dup-pending", pending=True),
                                 _raw("dup-posted", pending=False)]}, repo)
    assert _stored_charge(repo, "dup-pending") is not None
    assert _stored_charge(repo, "dup-posted") is not None
    repo.delete_transaction(_ACCOUNT_PK, "TXN#dup-pending")
    repo.delete_transaction(_ACCOUNT_PK, "TXN#dup-posted")
    assert _stored_charge(repo, "dup-pending") is None
    assert _stored_charge(repo, "dup-posted") is None
    seen_by_rules.clear()
    seen_by_alerts.clear()

    # BankSync re-sends both, alongside a new charge.
    handler.process_transaction(
        {"id": "evt-2", "data": [_raw("dup-pending", pending=True),
                                 _raw("dup-posted", pending=False),
                                 _raw("fresh", pending=False)]}, repo)

    assert _stored_charge(repo, "dup-pending") is None
    assert _stored_charge(repo, "dup-posted") is None
    assert _stored_charge(repo, "fresh") is not None
    assert seen_by_rules == ["fresh"]
    assert seen_by_alerts == ["fresh"]


def test_deleting_a_pending_still_lets_its_settled_charge_land(lam, repo, monkeypatch):
    handler = _setup(lam, monkeypatch)
    handler.process_transaction({"id": "e1", "data": [_raw("p1", pending=True)]}, repo)
    repo.delete_transaction(_ACCOUNT_PK, "TXN#p1")

    # The bank settles it: a new posted id pointing back at the deleted pending, plus a re-send.
    handler.process_transaction(
        {"id": "e2", "data": [_raw("p1", pending=True), _raw("posted-1", pending=False, pending_id="p1")]},
        repo)

    assert _charge_rows(repo) == {"TXN#posted-1"}


def test_an_unmapped_account_charge_still_goes_to_failed_not_the_filter(lam, repo, monkeypatch):
    handler = _setup(lam, monkeypatch)
    handler.process_transaction(
        {"id": "e1", "data": [_raw("x", pending=False, account="unknown-account")]}, repo)
    assert any(pk == "FAILED" for (pk, _sk) in repo._table.store)
