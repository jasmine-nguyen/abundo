"""WHIT-793 slice 1 QA: the entry points still hand the trimmed functions what they now require.

Both alert calls in process_transaction sit inside `except Exception`, so a call that no
longer fits the function's signature would silently switch every budget alert off.
"""

import inspect
import json

from _feed_fakes import FakeCategoryRepo
from _rule_ingest_fakes import FakeRuleStore


def _signature_spy(real, calls, result):
    """Records the arguments only if they bind to `real`'s signature."""
    signature = inspect.signature(real)

    def spy(*args, **kwargs):
        calls.append(signature.bind(*args, **kwargs).arguments)
        return result

    return spy


def test_process_transaction_calls_both_alert_steps_with_their_signatures(lam, repo, monkeypatch):
    # [A1]
    ba = lam.budget_alerts
    captured, fired = [], []
    monkeypatch.setattr(ba, "capture_pre_write", _signature_spy(ba.capture_pre_write, captured, {"ctx": True}))
    monkeypatch.setattr(ba, "fire_budget_alerts", _signature_spy(ba.fire_budget_alerts, fired, None))

    lam.handler.process_transaction({"id": "sync-1", "data": []}, repo)

    assert len(captured) == 1
    assert captured[0]["webhook_repo"] is repo
    assert len(fired) == 1
    assert fired[0]["ctx"] == {"ctx": True}


class _NoFailedRows:
    def get_failed_transactions(self):
        return []


def test_reprocess_lambda_handler_runs_the_real_sweep_with_its_stores(lam, monkeypatch):
    # [A2]
    rules = FakeRuleStore()
    monkeypatch.setattr(lam.reprocess, "TransactionRepository", _NoFailedRows)
    monkeypatch.setattr(lam.reprocess, "RuleRepository", lambda: rules)
    monkeypatch.setattr(lam.reprocess, "CategoryRepository", lambda: FakeCategoryRepo([]))

    resp = lam.reprocess.lambda_handler({}, None)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"reprocessed": 0, "skipped": 0, "errors": 0, "dropped_zero": 0}
    assert rules.list_calls == 1
