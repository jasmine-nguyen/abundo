"""Webhook-side rule filing (lambda/rule_ingest.py), WHIT-530.

Our server files each incoming charge by the user's own rules as it lands, now that BankSync no
longer labels them for us. Driven through the webhook `lam` fixture so rule_ingest, rule_engine and
banksync.counts_to_budget resolve the way the deployed webhook resolves them.

Local fakes (the webhook-suite convention — see test_budget_alerts.py): FakeRuleStore is a minimal
read-only snake_case rule store (`repository` is lambda/webhook_repository.py here, which does not export
DatabaseError).
"""

import logging
from decimal import Decimal

from _dynamo_fakes import FakeTable
from _feed_fakes import FakeCategoryRepo
from _category_fakes import budget_repo, stored_budgets
from _rule_ingest_fakes import FakePaycycle, FakeRuleStore, apply_rules


def _rule(value, category_id="groceries", *, field="description", operator="contains", rule_id=None,
          **extra):
    """A stored rule row (snake_case), the shape RuleRepository holds."""
    return {"id": rule_id or f"rule-{value}", "field": field, "operator": operator,
            "value": value, "category_id": category_id, **extra}


def _charge(txn_id="t1", description="COLES 123 RICHMOND", category=None,
            account_id="up-spending", counts_to_budget=True):
    """A normalised-charge-like dict (models.Transaction is dict-like)."""
    return {"transaction_id": txn_id, "account_id": account_id, "description": description,
            "category": category, "counts_to_budget": counts_to_budget}


# --- apply(): the batch entry point -------------------------------------------


def test_filing_stamps_the_winning_rule_id(lam):
    # WHIT-536: a rule-filed charge remembers which rule filed it.
    charge = _charge(description="COLES 55", category=None)
    apply_rules(lam.rule_ingest, [charge], rule_repo=FakeRuleStore([_rule("COLES", "groceries", rule_id="rule-9")]),
        category_repo=FakeCategoryRepo(["groceries"]))
    assert charge["category"] == "groceries"
    assert charge["filed_by_rule"] == "rule-9"     # FAIL-ON-REVERT: stamp line removed -> absent


def test_filing_recomputes_counts_to_budget(lam):
    # A rule that files into a NON-budget category must flip counts_to_budget off. The charge
    # starts counting (True); after filing to TRANSFER_OUT it must not count.
    charge = _charge(description="PAYID TO MUM", category=None, counts_to_budget=True)
    apply_rules(lam.rule_ingest, [charge], rule_repo=FakeRuleStore([_rule("PAYID", "TRANSFER_OUT")]),
        category_repo=FakeCategoryRepo(["TRANSFER_OUT"]))
    assert charge["category"] == "TRANSFER_OUT"
    assert charge["counts_to_budget"] is False        # FAIL-ON-REVERT: recompute line removed -> True


def test_rules_read_failure_leaves_the_charge_unfiled_and_logs(lam, caplog):
    charge = _charge(description="COLES", category=None)
    with caplog.at_level(logging.ERROR):
        is_unfiled = apply_rules(lam.rule_ingest, [charge], rule_repo=FakeRuleStore(error=True),
            category_repo=FakeCategoryRepo(["groceries"]))
    assert charge["category"] is None                # best-effort: charge still lands, unfiled
    assert is_unfiled is None                          # read failed: no gate for the carry
    assert "could not read rules" in caplog.text      # FAIL-ON-REVERT: no try/except -> raises


def test_sets_budget_excluded_when_the_winning_rule_excludes(lam):
    charge = _charge()
    apply_rules(lam.rule_ingest, [charge], rule_repo=FakeRuleStore([_rule("COLES", budget_excluded=True)]),
                category_repo=FakeCategoryRepo(["groceries"]))
    assert charge["category"] == "groceries"
    assert charge["budget_excluded"] is True


def test_does_not_exclude_when_matching_rules_disagree(lam):
    # Two rules match "COLES ONLINE" but file to different categories -> conflict, left unfiled.
    # The exclusion must not land on a charge no rule got to file.
    charge = _charge(description="COLES ONLINE")
    apply_rules(lam.rule_ingest, [charge],
                rule_repo=FakeRuleStore([_rule("COLES", "groceries", budget_excluded=True, rule_id="a"),
                                         _rule("ONLINE", "coffee", budget_excluded=True, rule_id="b")]),
                category_repo=FakeCategoryRepo(["groceries", "coffee"]))
    assert charge["category"] is None
    assert "budget_excluded" not in charge


# --- auto-spreading (WHIT-559): a spread rule seeds its category's plan once ---------
# The real RuleRepository and BudgetRepository run over the stand-in table, so the
# spread_seeded mark and the stored plan are the real ones.


def _rule_store(rules):
    import repository_rule

    store = repository_rule.RuleRepository()
    store._table = FakeTable()
    store._table.seed(*({"pk": "RULE", "sk": f"RULE#{rule['id']}", **rule} for rule in rules))
    return store


def _seeded(store):
    return [rule["id"] for rule in store.list_rules() if rule.get("spread_seeded")]


def _spread_rule():
    return _rule("ORIGIN", "insurance", rule_id="r-origin", spread=True, spread_seeded=False,
                 spread_amount=Decimal("42.50"), spread_gap_days=30)


def _apply_spreading(lam, store, budget, charges):
    paycycle = FakePaycycle()
    lam.rule_ingest.apply(charges, rule_repo=store, category_repo=FakeCategoryRepo(["insurance"]),
                          budget_repo=budget, paycycle_repo=paycycle)
    return paycycle


def _budget_writes(budget):
    return len(budget._table.update_calls) + len(budget._table.put_calls)


def test_a_spread_rule_seeds_the_plan_and_marks_it(lam):
    store = _rule_store([_spread_rule()])
    budget = budget_repo({"insurance": {"target": Decimal("100")}})
    charge = _charge("t1", description="ORIGIN ENERGY BILL")
    _apply_spreading(lam, store, budget, [charge])

    assert charge["category"] == "insurance" and charge["filed_by_rule"] == "r-origin"
    plan = stored_budgets(budget)["insurance"]
    assert (plan["spread_amount"], plan["spread_cycles"], plan["spread_len"]) == (Decimal("42.50"), 2, 14)
    assert _seeded(store) == ["r-origin"]


def test_two_deliveries_over_the_same_store_seed_once(lam):
    # Cross-DELIVERY idempotency: delivery 1 seeds + marks the store row; delivery 2 (a fresh
    # SpreadSeeder — the per-run dedup set does NOT carry over) reads the persisted spread_seeded and
    # skips: no pay-cycle read, no budget write. FAIL-ON-REVERT: stop reading spreadSeeded in
    # rule_book.rule_from_row (or stop mark_spread_seeded flipping it) and delivery 2 re-seeds.
    store = _rule_store([_spread_rule()])
    budget = budget_repo({"insurance": {"target": Decimal("100")}})
    _apply_spreading(lam, store, budget, [_charge("t1", description="ORIGIN ENERGY BILL")])
    assert "spread_amount" in stored_budgets(budget)["insurance"] and _seeded(store) == ["r-origin"]
    writes_after_first = _budget_writes(budget)

    paycycle = _apply_spreading(lam, store, budget, [_charge("t2", description="ORIGIN ENERGY BILL")])
    assert paycycle.get_calls == 0                          # delivery 2 does not re-seed
    assert _budget_writes(budget) == writes_after_first


# --- through process_transaction: wiring + order + carry-wins -----------------


_MAPPED_ACCOUNT = "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0"


def _raw(txn_id, *, description="COLES 123", category="FOOD_AND_DRINK", pending=False):
    return {"id": txn_id, "date": "2026-06-29", "authorizedDate": "2026-06-29",
            "description": description, "merchantName": description, "amount": -12.50,
            "accountId": _MAPPED_ACCOUNT, "accountName": "ANZ Rewards", "category": category,
            "pending": pending, "type": "PAYMENT", "pendingTransactionId": None}


def _stored(repo, txn_id):
    for (pk, sk), item in repo._table.store.items():
        if sk == f"TXN#{txn_id}":
            return item
    return None


def _wire(lam, monkeypatch, rules, categories):
    handler = lam.handler
    monkeypatch.setattr(handler, "RuleRepository", lambda: FakeRuleStore(rules))
    monkeypatch.setattr(handler, "CategoryRepository", lambda: FakeCategoryRepo(categories))
    # Budget-alert snapshot reads real repos; neutralise it (best-effort path) so the test
    # exercises only rule filing + reconcile.
    monkeypatch.setattr(handler.budget_alerts, "capture_pre_write", lambda *a, **k: None)
    return handler


def test_process_transaction_files_a_fresh_charge(lam, repo, monkeypatch):
    handler = _wire(lam, monkeypatch, [_rule("COLES", "groceries")], ["groceries"])
    handler.process_transaction({"id": "evt1", "data": [_raw("t1", description="COLES 9")]}, repo)
    assert _stored(repo, "t1")["category"] == "groceries"


def test_process_transaction_resend_keeps_the_users_stored_category(lam, repo, monkeypatch):
    # A pending the user hand-filed as "eating-out", then a re-send whose raw category is unfiled
    # and a rule matches. rule_ingest sets "groceries" on the incoming row, but the reconcile carry
    # must win, so the stored row keeps the user's "eating-out". (Regression guard for the
    # Option-A accepted behaviour: the carry protects a hand-filed choice.)
    handler = _wire(lam, monkeypatch, [_rule("COLES", "groceries")], ["groceries", "eating-out"])
    # Seed the stored pending with the user's choice. Build it via normalise so its account key
    # matches what the re-send will normalise to, then override the category to the hand-filed one.
    seed = lam.banksync.normalise(_raw("t9", description="COLES 123", pending=True))
    seed["category"] = "eating-out"
    seed["counts_to_budget"] = True
    repo.insert_or_reconcile([seed])
    assert _stored(repo, "t9")["category"] == "eating-out"

    handler.process_transaction(
        {"id": "evt2", "data": [_raw("t9", description="COLES 123", pending=True)]}, repo)
    assert _stored(repo, "t9")["category"] == "eating-out"    # carry wins over the rule's groceries
