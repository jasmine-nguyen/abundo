"""Shared stand-ins for the webhook's rule filing (rule_ingest.apply), the dead-letter
re-run (reprocess.reprocess_failed) and the API's "Apply my rules" sweep
(handler.apply_rules_to_uncategorized). On the pytest path via ``pythonpath = tests/shared`` (pytest.ini).
"""

from functools import partial

from _budget_endpoint_fakes import _FakeCategoryRepo
from _feed_fakes import FakeCategoryRepo


class FakeRuleStore:
    """Minimal RuleRepository stand-in: list_rules over snake_case rows; optional read failure."""

    def __init__(self, rules=(), *, error=False):
        self._rules = [dict(rule) for rule in rules]
        self.error = error
        self.list_calls = 0

    def list_rules(self):
        self.list_calls += 1
        if self.error:
            raise RuntimeError("rules read failed")
        return [dict(rule) for rule in self._rules]


KKV_RULE = {"id": "r-kkv", "field": "description", "operator": "contains",
            "value": "KKV", "category_id": "groceries"}

SubscriptionCategories = partial(_FakeCategoryRepo, [{"id": "subscriptions"}])


_MAPPED_ACCOUNT = "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0"


def raw_charge(txn_id, *, description="COLES 123", category="FOOD_AND_DRINK", pending=False):
    """A raw BankSync charge on the webhook's mapped ANZ account, as process_transaction receives it."""
    return {"id": txn_id, "date": "2026-06-29", "authorizedDate": "2026-06-29",
            "description": description, "merchantName": description, "amount": -12.50,
            "accountId": _MAPPED_ACCOUNT, "accountName": "ANZ Rewards", "category": category,
            "pending": pending, "type": "PAYMENT", "pendingTransactionId": None}


def reprocess_failed(reprocess, repo):
    """reprocess.reprocess_failed with no rules and an empty taxonomy."""
    return reprocess.reprocess_failed(repo, rule_repo=FakeRuleStore(), category_repo=FakeCategoryRepo([]))


def wire_rule_filing(lam, monkeypatch, rules, categories):
    """The webhook handler with these rules and categories, and the budget-alert snapshot
    neutralised so a test sees only rule filing and reconcile."""
    handler = lam.handler
    monkeypatch.setattr(handler, "RuleRepository", lambda: FakeRuleStore(rules))
    monkeypatch.setattr(handler, "CategoryRepository", lambda: FakeCategoryRepo(categories))
    monkeypatch.setattr(handler.budget_alerts, "capture_pre_write", lambda *a, **k: None)
    return handler
