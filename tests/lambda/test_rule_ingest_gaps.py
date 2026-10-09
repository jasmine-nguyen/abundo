"""WHIT-530: webhook-side rule filing runs BEFORE the budget-alert snapshot, so the snapshot
sees the rule-filed state (lambda/handler.py process_transaction)."""

from _feed_fakes import FakeCategoryRepo
from _rule_ingest_fakes import FakeRuleStore

_MAPPED_ACCOUNT = "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0"


def _raw(txn_id, *, description="COLES 123", category="FOOD_AND_DRINK", pending=False):
    return {"id": txn_id, "date": "2026-06-29", "authorizedDate": "2026-06-29",
            "description": description, "merchantName": description, "amount": -12.50,
            "accountId": _MAPPED_ACCOUNT, "accountName": "ANZ Rewards", "category": category,
            "pending": pending, "type": "PAYMENT", "pendingTransactionId": None}


def test_budget_snapshot_sees_rule_filed_category_and_flag(lam, repo, monkeypatch):
    # [A8] apply() runs BEFORE capture_pre_write, so the budget-alert snapshot must observe the
    # rule-filed category + recomputed counts_to_budget, NOT the raw enum. A spy records what
    # capture actually receives (at call time). FAIL-ON-REVERT: move apply() after capture (or
    # drop it) and the spy sees the raw FOOD_AND_DRINK with counts_to_budget True.
    seen = {}

    def spy_capture(txns, **kwargs):
        charge = txns[0]
        seen["category"] = charge["category"]
        seen["counts_to_budget"] = charge["counts_to_budget"]
        return None

    monkeypatch.setattr(lam.handler, "RuleRepository",
                        lambda: FakeRuleStore([{"id": "rule-PAYID", "field": "description",
                                                "operator": "contains", "value": "PAYID",
                                                "category_id": "TRANSFER_OUT"}]))
    monkeypatch.setattr(lam.handler, "CategoryRepository",
                        lambda: FakeCategoryRepo(["TRANSFER_OUT"]))
    monkeypatch.setattr(lam.handler.budget_alerts, "capture_pre_write", spy_capture)

    lam.handler.process_transaction(
        {"id": "evt1", "data": [_raw("t1", description="PAYID TO MUM", category="FOOD_AND_DRINK")]},
        repo)

    assert seen["category"] == "TRANSFER_OUT"
    assert seen["counts_to_budget"] is False
