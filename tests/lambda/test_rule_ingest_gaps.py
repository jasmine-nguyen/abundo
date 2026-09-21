"""WHIT-530 adversarial GAPS for webhook-side rule filing (lambda/rule_ingest.py).

Independent of test_rule_ingest.py / test_reprocess.py: only the edges those don't lock —
non-taxonomy truthy raw categories, the category/equals rule shape, `income`, a full mixed
batch, the capture_pre_write ordering, the read-once contract on reprocess, and the per-charge
KeyError that lives OUTSIDE the best-effort try/except.

Local fakes only (webhook-suite convention): the shared tests/shared/_rule_fakes.py error path
imports DatabaseError from `repository`, which is lambda/repository.py here and lacks it.
"""

import logging

import pytest


# --- local fakes (snake_case store, list-call counting) ----------------------


class FakeRuleStore:
    def __init__(self, rules=(), *, error=False):
        self._rules = [dict(rule) for rule in rules]
        self.error = error
        self.list_calls = 0

    def list_rules(self):
        self.list_calls += 1
        if self.error:
            raise RuntimeError("rules read failed")
        return [dict(rule) for rule in self._rules]


class FakeCategoryRepo:
    def __init__(self, category_ids):
        self._ids = list(category_ids)
        self.list_calls = 0

    def list_categories(self):
        self.list_calls += 1
        return [{"id": category_id} for category_id in self._ids]


def _rule(value, category_id="groceries", *, field="description", operator="contains", rule_id=None):
    return {"id": rule_id or f"rule-{value}", "field": field, "operator": operator,
            "value": value, "category_id": category_id}


def _charge(txn_id="t1", description="COLES 123 RICHMOND", category=None,
            account_id="up-spending", counts_to_budget=True):
    return {"transaction_id": txn_id, "account_id": account_id, "description": description,
            "category": category, "counts_to_budget": counts_to_budget}


# --- GAP: a truthy-but-non-taxonomy raw category is still "unfiled" -> filed --


def test_non_taxonomy_raw_category_is_filed(lam):
    # WHIT-530 — [A1] a charge wearing a raw enum ("FOOD_AND_DRINK") that is NOT in the user's
    # taxonomy is unfiled, so a matching description rule must file it. FAIL-ON-REVERT: if
    # is_unfiled treated any truthy category as filed, the raw enum would survive.
    charge = _charge(description="COLES 9", category="FOOD_AND_DRINK")
    lam.rule_ingest.apply(
        [charge], rule_repo=FakeRuleStore([_rule("COLES", "groceries")]),
        category_repo=FakeCategoryRepo(["groceries"]))
    assert charge["category"] == "groceries"


# --- GAP: the category/equals rule shape files, not just description/contains -


def test_category_equals_rule_files(lam):
    # WHIT-530 — [A2] a category/equals rule (raw-enum mapping) matching the charge's raw enum
    # must file it; a non-matching enum stays put (equals is exact, not substring).
    hit = _charge(txn_id="hit", description="anything", category="FOOD_AND_DRINK")
    miss = _charge(txn_id="miss", description="anything", category="GENERAL_MERCHANDISE")
    rule = _rule("FOOD_AND_DRINK", "groceries", field="category", operator="equals")
    lam.rule_ingest.apply(
        [hit, miss], rule_repo=FakeRuleStore([rule]),
        category_repo=FakeCategoryRepo(["groceries"]))
    assert hit["category"] == "groceries"
    assert miss["category"] == "GENERAL_MERCHANDISE"


# --- GAP: `income` — filed already (left alone) AND a valid rule target -------


def test_income_charge_is_left_alone(lam):
    # [A3] is_unfiled_category treats "income" as filed. A charge already "income" must not be
    # re-filed by a matching rule. FAIL-ON-REVERT: if income were treated as unfiled, it files.
    charge = _charge(description="COLES", category="income")
    lam.rule_ingest.apply(
        [charge], rule_repo=FakeRuleStore([_rule("COLES", "groceries")]),
        category_repo=FakeCategoryRepo(["groceries"]))
    assert charge["category"] == "income"


def test_rule_filing_to_income_is_applied(lam):
    # [A4] a rule may file TO income even though income is not a taxonomy id: _skip_reason accepts
    # it. counts_to_budget leaves income counting. FAIL-ON-REVERT: if _skip_reason dropped
    # income-targeted rules as "category no longer exists", the charge stays unfiled.
    charge = _charge(description="SALARY ACME", category=None)
    lam.rule_ingest.apply(
        [charge], rule_repo=FakeRuleStore([_rule("SALARY", "income")]),
        category_repo=FakeCategoryRepo(["groceries"]))       # taxonomy has NO "income"
    assert charge["category"] == "income"
    assert charge["counts_to_budget"] is True


# --- GAP: one apply() call, four outcomes, all independent --------------------


def test_mixed_batch_each_charge_resolved_independently(lam):
    # [A5] filed / conflict / already-filed / no-match together in ONE apply call. Each row is
    # decided on its own; one conflict or already-filed row must not stop the others. The conflict
    # is a genuinely NON-nested disagreement (COLES vs RICHMOND, neither contains the other) — a
    # nested disagreement now resolves to the more specific rule (WHIT-518).
    filed = _charge(txn_id="filed", description="ALDI STORE", category=None)
    conflict = _charge(txn_id="conflict", description="COLES 0342 RICHMOND", category=None)
    prefiled = _charge(txn_id="prefiled", description="COLES 1", category="eating-out")
    nomatch = _charge(txn_id="nomatch", description="WOOLWORTHS", category=None)
    rules = [_rule("ALDI", "groceries", rule_id="r-aldi"),
             _rule("COLES", "groceries", rule_id="r-coles"),
             _rule("RICHMOND", "coffee", rule_id="r-richmond")]
    lam.rule_ingest.apply(
        [filed, conflict, prefiled, nomatch],
        rule_repo=FakeRuleStore(rules),
        category_repo=FakeCategoryRepo(["groceries", "coffee", "eating-out"]))
    assert filed["category"] == "groceries"
    assert conflict["category"] is None
    assert prefiled["category"] == "eating-out"
    assert nomatch["category"] is None


# --- GAP: rule value below the WHIT-529 write-time floor still matches here ---


def test_short_rule_value_below_write_floor_still_matches(lam):
    # [A6] WHIT-529's >=4-alphanumeric floor is a WRITE-TIME guard on /rules, NOT re-checked here.
    # A short imported rule ("KKV", 3 alphanumerics) still files at ingest. Pins parity with the
    # "Apply my rules" sweep; a revert adding a floor here would leave this unfiled.
    charge = _charge(description="SQ *KKV INTERNATIONAL PTY", category=None)
    lam.rule_ingest.apply(
        [charge], rule_repo=FakeRuleStore([_rule("KKV", "groceries")]),
        category_repo=FakeCategoryRepo(["groceries"]))
    assert charge["category"] == "groceries"


# --- GAP: per-charge work (counts_to_budget) is OUTSIDE the try/except --------


def test_charge_missing_account_id_raises_when_filing(lam):
    # [A7] load_rules swallows a rules/taxonomy read failure, but per-charge filing is NOT wrapped:
    # a matched charge missing account_id hits counts_to_budget(charge["account_id"], ...) and
    # raises KeyError, propagating out of apply. FAIL-ON-REVERT: if account_id were read with
    # .get(), this would not raise.
    charge = {"transaction_id": "t1", "description": "COLES", "category": None}
    with pytest.raises(KeyError):
        lam.rule_ingest.apply(
            [charge], rule_repo=FakeRuleStore([_rule("COLES", "groceries")]),
            category_repo=FakeCategoryRepo(["groceries"]))


# --- GAP: ordering — capture_pre_write sees the RULE-FILED state --------------


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
                        lambda: FakeRuleStore([_rule("PAYID", "TRANSFER_OUT")]))
    monkeypatch.setattr(lam.handler, "CategoryRepository",
                        lambda: FakeCategoryRepo(["TRANSFER_OUT"]))
    monkeypatch.setattr(lam.handler.budget_alerts, "capture_pre_write", spy_capture)

    lam.handler.process_transaction(
        {"id": "evt1", "data": [_raw("t1", description="PAYID TO MUM", category="FOOD_AND_DRINK")]},
        repo)

    assert seen["category"] == "TRANSFER_OUT"
    assert seen["counts_to_budget"] is False


# --- GAP: reprocess reads rules ONCE for the whole sweep, not per row ---------


def test_reprocess_reads_rules_once_across_many_rows(lam, repo):
    # [A9] load_rules is called ONCE before the loop; N recovered rows share it. FAIL-ON-REVERT:
    # move load_rules inside the per-row loop and both counters climb to 3.
    for i in range(3):
        repo.save_failed_transactions([_raw(f"r{i}", description="COLES 9", category="FOOD_AND_DRINK")])
    rule_store = FakeRuleStore([_rule("COLES", "groceries")])
    category_store = FakeCategoryRepo(["groceries"])

    summary = lam.reprocess.reprocess_failed(repo, rule_repo=rule_store, category_repo=category_store)

    assert summary == {"reprocessed": 3, "skipped": 0, "errors": 0}
    assert rule_store.list_calls == 1
    assert category_store.list_calls == 1
