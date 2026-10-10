"""WHIT-530: webhook-side rule filing runs BEFORE the budget-alert snapshot, so the snapshot
sees the rule-filed state (lambda/handler.py process_transaction)."""

from _rule_ingest_fakes import raw_charge, wire_rule_filing


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

    handler = wire_rule_filing(lam, monkeypatch,
                               [{"id": "rule-PAYID", "field": "description", "operator": "contains",
                                 "value": "PAYID", "category_id": "TRANSFER_OUT"}],
                               ["TRANSFER_OUT"])
    monkeypatch.setattr(handler.budget_alerts, "capture_pre_write", spy_capture)

    handler.process_transaction(
        {"id": "evt1", "data": [raw_charge("t1", description="PAYID TO MUM", category="FOOD_AND_DRINK")]},
        repo)

    assert seen["category"] == "TRANSFER_OUT"
    assert seen["counts_to_budget"] is False
