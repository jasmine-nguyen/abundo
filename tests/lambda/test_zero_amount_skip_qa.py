"""WHIT-705 QA: edges of the $0.00 drop at the webhook ingest and the dead-letter reprocess sweep.

Driven through process_transaction / reprocess_failed with the webhook's REAL TransactionRepository
over a FakeTable, like test_zero_amount_skip.py.
"""

import logging
from functools import partial

from _budget_endpoint_fakes import _FakeCategoryRepo
from _deadletter_fakes import _failed_keys, _txn_rows
from _rule_ingest_fakes import reprocess_failed


class _NoRules:
    def list_rules(self):
        return []


_Categories = partial(_FakeCategoryRepo, [{"id": "subscriptions"}])


_MAPPED_ACCOUNT = "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0"


def _raw(txn_id, *, amount, description="FOREIGN FEE AUD 5.10", pending=False):
    return {"id": txn_id, "date": "2026-09-27", "authorizedDate": "2026-09-27",
            "description": description, "merchantName": "",
            "amount": amount, "accountId": _MAPPED_ACCOUNT, "accountName": "Westpac Altitude",
            "category": "BANK_FEES", "pending": pending, "type": "PAYMENT",
            "pendingTransactionId": None}


def _wire(handler, monkeypatch):
    monkeypatch.setattr(handler, "RuleRepository", _NoRules)
    monkeypatch.setattr(handler, "CategoryRepository", _Categories)
    monkeypatch.setattr(handler.budget_alerts, "capture_pre_write", lambda *a, **k: None)


# [A1]
def test_the_skip_is_logged_with_the_count_of_dropped_rows(lam, repo, monkeypatch, caplog):
    handler = lam.handler
    _wire(handler, monkeypatch)

    with caplog.at_level(logging.INFO):
        handler.process_transaction({"id": "evt-log", "data": [
            _raw("fee-a", amount=0),
            _raw("fee-b", amount="0.00"),
            _raw("charge", amount=-25.73, description="ATP MEDIA WIMBLEDON"),
        ]}, repo)

    assert "skipped 2 $0.00 transaction(s)" in caplog.text


# [A2]
def test_no_skip_line_is_logged_when_nothing_is_zero(lam, repo, monkeypatch, caplog):
    handler = lam.handler
    _wire(handler, monkeypatch)

    with caplog.at_level(logging.INFO):
        handler.process_transaction({"id": "evt-nolog", "data": [
            _raw("charge", amount=-25.73, description="ATP MEDIA WIMBLEDON"),
        ]}, repo)

    assert "$0.00 transaction" not in caplog.text
    assert "TXN#charge" in _txn_rows(repo)


# [A3]
def test_a_payload_of_only_zero_rows_stores_nothing_and_does_not_fail(lam, repo, monkeypatch):
    handler = lam.handler
    _wire(handler, monkeypatch)

    handler.process_transaction({"id": "evt-all-zero", "data": [
        _raw("fee-a", amount=0),
        _raw("fee-b", amount=0.0, pending=True),
    ]}, repo)

    assert _txn_rows(repo) == {}
    assert _failed_keys(repo) == []


# [A4]
def test_negative_zero_and_padded_zero_strings_are_dropped(lam, repo, monkeypatch):
    handler = lam.handler
    _wire(handler, monkeypatch)

    handler.process_transaction({"id": "evt-neg-zero", "data": [
        _raw("neg-zero", amount="-0.00"),
        _raw("long-zero", amount="0.000"),
        _raw("credit", amount=0.01, description="REFUND"),
    ]}, repo)

    stored = _txn_rows(repo)
    assert "TXN#neg-zero" not in stored
    assert "TXN#long-zero" not in stored
    assert "TXN#credit" in stored


# [A5]
def test_a_zero_resend_of_a_stored_charge_leaves_the_stored_amount_alone(lam, repo, monkeypatch):
    # Accepted risk in the plan: a re-send with its amount changed to 0 is dropped, not applied.
    handler = lam.handler
    _wire(handler, monkeypatch)
    handler.process_transaction({"id": "evt-1", "data": [_raw("charge", amount=-5.10)]}, repo)

    handler.process_transaction({"id": "evt-2", "data": [_raw("charge", amount=0)]}, repo)

    assert str(_txn_rows(repo)["TXN#charge"]["amount"]) == "-5.1"


# [A6]
def test_reprocess_never_files_a_zero_row_by_rules(lam, repo, monkeypatch):
    repo.save_failed_transactions([
        _raw("fee-zero", amount=0),
        _raw("charge", amount=-175.11, description="ANTHROPIC"),
    ])
    filed = []
    book_class = lam.rule_ingest.RuleBook
    real_file_charges = book_class.file_charges

    def recording_file_charges(book, charges, *args, **kwargs):
        filed.extend(charge["transaction_id"] for charge in charges)
        return real_file_charges(book, charges, *args, **kwargs)

    monkeypatch.setattr(book_class, "file_charges", recording_file_charges)

    summary = lam.reprocess.reprocess_failed(repo, rule_repo=_NoRules(), category_repo=_Categories())

    assert filed == ["charge"]
    assert summary == {"reprocessed": 1, "skipped": 0, "errors": 0, "dropped_zero": 1}
    assert "TXN#fee-zero" not in _txn_rows(repo)


# [A7]
def test_reprocess_never_passes_a_zero_row_to_the_write(lam, repo, monkeypatch):
    repo.save_failed_transactions([_raw("fee-zero", amount="0.00", pending=True)])
    written = []
    monkeypatch.setattr(repo, "insert_or_reconcile",
                        lambda transactions, **kwargs: written.extend(transactions))

    summary = reprocess_failed(lam.reprocess, repo)

    assert written == []
    assert summary["dropped_zero"] == 1
    assert _failed_keys(repo) == []


# [A8]
def test_a_failed_clear_of_a_zero_dead_letter_is_an_error_and_leaves_it_for_next_run(lam, repo):
    repo.save_failed_transactions([
        _raw("fee-zero", amount=0),
        _raw("charge", amount=-175.11, description="ANTHROPIC"),
    ])
    zero_sk = next(sk for pk, sk in _failed_keys(repo)
                   if "fee-zero" in repo._table.store[(pk, sk)]["raw"])
    repo._table.fail("delete_item", when=lambda key: key["sk"] == zero_sk)

    summary = reprocess_failed(lam.reprocess, repo)

    assert summary == {"reprocessed": 1, "skipped": 0, "errors": 1, "dropped_zero": 0}
    assert ("FAILED", zero_sk) in repo._table.store
    assert "TXN#fee-zero" not in _txn_rows(repo)
    assert "TXN#charge" in _txn_rows(repo)

    repo._table.clear_failures()
    again = reprocess_failed(lam.reprocess, repo)

    assert again == {"reprocessed": 0, "skipped": 0, "errors": 0, "dropped_zero": 1}
    assert _failed_keys(repo) == []
