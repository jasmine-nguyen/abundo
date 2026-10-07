"""Shared stand-ins for the webhook's rule filing (rule_ingest.apply), the dead-letter
re-run (reprocess.reprocess_failed) and the API's "Apply my rules" sweep
(handler.apply_rules_to_uncategorized), which always take their rule, taxonomy, budget and
pay-cycle stores (WHIT-793). On the pytest path via ``pythonpath = tests/shared`` (pytest.ini).
"""

from functools import partial

from _budget_endpoint_fakes import _FakePayCycleRepo
from _category_fakes import budget_repo
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


FakePaycycle = partial(_FakePayCycleRepo, length=14, last_pay_date="2026-01-07")


def apply_rules(rule_ingest, rows, *, rule_repo, category_repo):
    """rule_ingest.apply with idle spread stores, for tests that don't look at spreading."""
    return rule_ingest.apply(rows, rule_repo=rule_repo, category_repo=category_repo,
                             budget_repo=budget_repo(), paycycle_repo=FakePaycycle())


def reprocess_failed(reprocess, repo):
    """reprocess.reprocess_failed with no rules and an empty taxonomy."""
    return reprocess.reprocess_failed(repo, rule_repo=FakeRuleStore(), category_repo=FakeCategoryRepo([]))


def apply_rules_to_uncategorized(handler, event, transaction_repo, category_repo, rule_repo):
    """The API's rules sweep with idle spread stores, for tests that don't look at spreading."""
    return handler.apply_rules_to_uncategorized(
        event, transaction_repo, category_repo, rule_repo, budget_repo(), FakePaycycle())
