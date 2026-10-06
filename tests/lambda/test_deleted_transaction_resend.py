"""A charge the user deleted must not come back through a BankSync re-send (WHIT-654).

BankSync re-sends each charge for 7 days. Without the "deleted by you" marker, the webhook's
reconcile turns the re-send into an insert and the charge reappears. Driven through
process_transaction with the webhook's REAL TransactionRepository over a FakeTable; the delete is
the shared repository's own delete_transaction (the one the app's DELETE route uses), inherited by
the webhook repository.
"""
from functools import partial

from _budget_endpoint_fakes import _FakeCategoryRepo


class _NoRules:
    def list_rules(self):
        return []


_Categories = partial(_FakeCategoryRepo, [{"id": "subscriptions"}])


_MAPPED_ACCOUNT = "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0"
_ACCOUNT_PK = "ACCOUNT#anz-rewards-black-visa"


def _raw(txn_id, *, pending):
    return {"id": txn_id, "date": "2026-09-27", "authorizedDate": "2026-09-27",
            "description": "ANTHROPIC* CLAUDE SUB", "merchantName": "Anthropic",
            "amount": -170.01, "accountId": _MAPPED_ACCOUNT, "accountName": "ANZ Rewards",
            "category": None, "pending": pending, "type": "PAYMENT",
            "pendingTransactionId": None}


def _stored_charge(repo, txn_id):
    return repo._table.store.get((_ACCOUNT_PK, f"TXN#{txn_id}"))


def test_a_deleted_charge_resent_by_the_bank_is_not_saved_again(lam, repo, monkeypatch):
    handler = lam.handler
    monkeypatch.setattr(handler, "RuleRepository", _NoRules)
    monkeypatch.setattr(handler, "CategoryRepository", _Categories)

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
