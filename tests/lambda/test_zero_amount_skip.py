"""WHIT-705: a $0.00 transaction from the bank is never stored.

Westpac sends "FOREIGN FEE AUD x.xx" rows with amount 0 — the real fee is already folded into
the purchase. Driven through the two ingest paths (process_transaction and the dead-letter
reprocess sweep) with the webhook's REAL TransactionRepository over a FakeTable.
"""

from _deadletter_fakes import _failed_keys, _txn_rows

from _rule_ingest_fakes import FakeRuleStore, SubscriptionCategories, reprocess_failed


_MAPPED_ACCOUNT = "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0"


def _raw(txn_id, *, amount, description="ANTHROPIC* CLAUDE SUB", pending=False):
    return {"id": txn_id, "date": "2026-09-27", "authorizedDate": "2026-09-27",
            "description": description, "merchantName": "",
            "amount": amount, "accountId": _MAPPED_ACCOUNT, "accountName": "Westpac Altitude",
            "category": "BANK_FEES", "pending": pending, "type": "PAYMENT",
            "pendingTransactionId": None}


def test_a_zero_dollar_row_from_the_bank_is_dropped_and_real_charges_are_stored(lam, repo, monkeypatch):
    handler = lam.handler
    monkeypatch.setattr(handler, "RuleRepository", FakeRuleStore)
    monkeypatch.setattr(handler, "CategoryRepository", SubscriptionCategories)

    seen_by_rules = []
    real_apply = handler.rule_ingest.apply

    def recording_apply(transactions, **kwargs):
        seen_by_rules.extend(transaction["transaction_id"] for transaction in transactions)
        return real_apply(transactions, **kwargs)

    monkeypatch.setattr(handler.rule_ingest, "apply", recording_apply)

    seen_by_alerts = []

    def recording_capture(transactions, **kwargs):
        seen_by_alerts.extend(transaction["transaction_id"] for transaction in transactions)
        return None

    monkeypatch.setattr(handler.budget_alerts, "capture_pre_write", recording_capture)

    seen_by_write = []
    real_insert = repo.insert_or_reconcile

    def recording_insert(transactions, **kwargs):
        seen_by_write.extend(transaction["transaction_id"] for transaction in transactions)
        return real_insert(transactions, **kwargs)

    monkeypatch.setattr(repo, "insert_or_reconcile", recording_insert)

    handler.process_transaction(
        {"id": "evt-1", "data": [
            _raw("fee-zero", amount=0, description="FOREIGN FEE AUD 5.10"),
            _raw("fee-zero-decimal", amount="0.00", description="FOREIGN FEE AUD 0.74"),
            _raw("fee-zero-pending", amount=0.0, description="FOREIGN FEE AUD 1.20", pending=True),
            _raw("charge", amount=-175.11),
            _raw("tiny", amount=-0.01),
        ]}, repo)

    stored = _txn_rows(repo)
    assert "TXN#charge" in stored
    assert "TXN#tiny" in stored
    assert "TXN#fee-zero" not in stored
    assert "TXN#fee-zero-decimal" not in stored
    assert "TXN#fee-zero-pending" not in stored
    assert seen_by_write == ["charge", "tiny"]
    assert seen_by_rules == ["charge", "tiny"]
    assert seen_by_alerts == ["charge", "tiny"]


def test_a_dead_lettered_zero_dollar_row_is_cleared_not_stored(lam, repo):
    repo.save_failed_transactions([
        _raw("fee-zero", amount=0, description="FOREIGN FEE AUD 5.10"),
        _raw("charge", amount=-175.11),
    ])
    assert len(_failed_keys(repo)) == 2

    summary = reprocess_failed(lam.reprocess, repo)

    assert summary == {"reprocessed": 1, "skipped": 0, "errors": 0, "dropped_zero": 1}
    stored = _txn_rows(repo)
    assert "TXN#charge" in stored
    assert "TXN#fee-zero" not in stored
    assert _failed_keys(repo) == []
