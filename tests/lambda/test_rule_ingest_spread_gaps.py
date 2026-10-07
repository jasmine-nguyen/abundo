"""WHIT-559 PR2a — adversarial gaps on the WEBHOOK-side auto-spreading (lambda/rule_ingest.py).

Independent of the impl suite (test_rule_ingest_spread.py, which covers seed+mark / two-charges-once
/ no-op-not-marked / non-spread-zero / already-seeded). Here: cross-DELIVERY
idempotency (the store-row spread_seeded flag survives across two deliveries, each with its OWN
SpreadSeeder), a multi-condition (WHIT-541) spread rule, a spread rule matching nothing, and a
budget_excluded (non-spread) regression with the spread wiring live. The real RuleRepository runs over
the stand-in table, like test_rule_ingest_spread.py."""

from decimal import Decimal

from _dynamo_fakes import FakeTable
from _feed_fakes import FakeCategoryRepo
from _rule_ingest_fakes import FakePaycycle


def _rule_store(rules):
    import repository_rule

    store = repository_rule.RuleRepository()
    store._table = FakeTable()
    store._table.seed(*({"pk": "RULE", "sk": f"RULE#{rule['id']}", **rule} for rule in rules))
    return store


def _seeded(store):
    return [rule["id"] for rule in store.list_rules() if rule.get("spread_seeded")]


class FakeBudget:
    def __init__(self, result={"id": "x"}):
        self._result = result
        self.calls = []

    def set_spread_if_absent(self, *args):
        self.calls.append(args)
        return self._result


def _charge(txn_id, description="ORIGIN ENERGY BILL", **extra):
    return {"transaction_id": txn_id, "account_id": "up-spending",
            "description": description, "category": None, "counts_to_budget": True, **extra}


def _spread_rule(**over):
    return {"id": "r-origin", "field": "description", "operator": "contains", "value": "ORIGIN",
            "category_id": "insurance", "spread": True, "spread_seeded": False,
            "spread_amount": Decimal("42.50"), "spread_gap_days": 30, **over}


def _apply(lam, store, charges, *, categories=("insurance",)):
    budget, paycycle = FakeBudget(), FakePaycycle()
    lam.rule_ingest.apply(charges, rule_repo=store, category_repo=FakeCategoryRepo(list(categories)),
                          budget_repo=budget, paycycle_repo=paycycle)
    return budget, paycycle


def test_two_deliveries_over_the_same_store_seed_once(lam):
    # [A10] Cross-DELIVERY idempotency: delivery 1 seeds + marks the store row; delivery 2 (a fresh
    # SpreadSeeder — the per-run dedup set does NOT carry over) reads the persisted spread_seeded and
    # skips. This is the guarantee that makes the webhook and the sweep never double-seed: it lives in
    # the store row, not the in-memory run. FAIL-ON-REVERT: stop reading spreadSeeded in rule_book.rule_from_row
    # (or stop mark_spread_seeded flipping it) and delivery 2 re-seeds.
    store = _rule_store([_spread_rule()])
    b1, _ = _apply(lam, store, [_charge("t1")])
    assert len(b1.calls) == 1 and _seeded(store) == ["r-origin"]

    b2, p2 = _apply(lam, store, [_charge("t2")])
    assert b2.calls == [] and p2.get_calls == 0            # delivery 2 does not re-seed


def test_a_multi_condition_spread_rule_still_seeds(lam):
    # [A11] A WHIT-541 multi-condition spread rule carries spread through rule_book.rule_from_row, so a charge
    # matching every condition still auto-seeds the plan.
    conditions = [{"field": "description", "operator": "contains", "value": "ORIGIN"},
                  {"field": "amount", "operator": "less_than", "value": "100"}]
    rule = _spread_rule(conditions=conditions, logic="all")
    store = _rule_store([rule])
    charge = _charge("t1", amount=Decimal("-42.50"))
    budget, _ = _apply(lam, store, [charge])
    assert charge["category"] == "insurance"
    assert len(budget.calls) == 1 and _seeded(store) == ["r-origin"]


def test_a_spread_rule_matching_nothing_reads_no_paycycle(lam):
    # [A12] No matching charge -> the seeder is never invoked -> zero pay-cycle read, zero budget write.
    store = _rule_store([_spread_rule(value="NOMATCH")])
    charge = _charge("t1")
    budget, paycycle = _apply(lam, store, [charge])
    assert charge["category"] is None
    assert budget.calls == [] and paycycle.get_calls == 0 and _seeded(store) == []


def test_a_budget_excluded_non_spread_rule_still_files_and_excludes(lam):
    # [A13] Regression: with the spread wiring present, a plain budget_excluded rule still files the
    # charge, sets budget_excluded, and touches no budget/paycycle repo.
    store = _rule_store([_spread_rule(spread=False, budget_excluded=True)])
    charge = _charge("t1")
    budget, paycycle = _apply(lam, store, [charge])
    assert charge["category"] == "insurance" and charge["budget_excluded"] is True
    assert budget.calls == [] and paycycle.get_calls == 0 and _seeded(store) == []
