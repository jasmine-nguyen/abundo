"""Webhook-side rule filing (lambda/rule_ingest.py), WHIT-530.

Our server files each incoming charge by the user's own rules as it lands, now that BankSync no
longer labels them for us. Driven through the webhook `lam` fixture so rule_ingest, rule_engine and
banksync.counts_to_budget resolve the way the deployed webhook resolves them.

Local fakes (the webhook-suite convention — see test_budget_alerts.py): FakeRuleStore is a minimal
snake_case rule store, deliberately NOT the shared tests/shared/_rule_fakes.FakeRuleRepo (whose
error path imports DatabaseError from `repository`, which is lambda/repository.py here and does not
export it).
"""

import logging
from decimal import Decimal

import pytest


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


class FakeCategoryRepo:
    def __init__(self, category_ids):
        self._ids = list(category_ids)

    def list_categories(self):
        return [{"id": category_id} for category_id in self._ids]


def _rule(value, category_id="groceries", *, field="description", operator="contains", rule_id=None):
    """A stored rule row (snake_case), the shape RuleRepository holds."""
    return {"id": rule_id or f"rule-{value}", "field": field, "operator": operator,
            "value": value, "category_id": category_id}


def _charge(txn_id="t1", description="COLES 123 RICHMOND", category=None,
            account_id="up-spending", counts_to_budget=True):
    """A normalised-charge-like dict (models.Transaction is dict-like)."""
    return {"transaction_id": txn_id, "account_id": account_id, "description": description,
            "category": category, "counts_to_budget": counts_to_budget}


# --- apply(): the batch entry point -------------------------------------------


def test_empty_store_is_a_noop(lam):
    charge = _charge(category=None)
    before = dict(charge)
    rows, _ = lam.rule_ingest.apply(
        [charge], rule_repo=FakeRuleStore([]), category_repo=FakeCategoryRepo(["groceries"]))
    assert rows[0] == before                 # returned untouched
    assert charge["category"] is None       # nothing filed


def test_empty_batch_reads_nothing(lam):
    # A data-less delivery (summary event) must not pay for the rules/taxonomy reads.
    # FAIL-ON-REVERT: drop the `if not rows` guard and list_rules is called once.
    store = FakeRuleStore([_rule("COLES", "groceries")])
    rows, is_unfiled = lam.rule_ingest.apply([], rule_repo=store, category_repo=FakeCategoryRepo(["groceries"]))
    assert rows == []
    assert is_unfiled is None                 # data-less delivery reads no taxonomy -> no carry gate
    assert store.list_calls == 0


def test_one_matching_rule_files_the_charge(lam):
    charge = _charge(description="COLES 55", category=None)
    lam.rule_ingest.apply(
        [charge], rule_repo=FakeRuleStore([_rule("COLES", "groceries")]),
        category_repo=FakeCategoryRepo(["groceries"]))
    assert charge["category"] == "groceries"


def test_filing_stamps_the_winning_rule_id(lam):
    # WHIT-536: a rule-filed charge remembers which rule filed it.
    charge = _charge(description="COLES 55", category=None)
    lam.rule_ingest.apply(
        [charge], rule_repo=FakeRuleStore([_rule("COLES", "groceries", rule_id="rule-9")]),
        category_repo=FakeCategoryRepo(["groceries"]))
    assert charge["category"] == "groceries"
    assert charge["filed_by_rule"] == "rule-9"     # FAIL-ON-REVERT: stamp line removed -> absent


def test_an_unfiled_charge_gets_no_stamp(lam):
    # No rule matches → not filed → nothing to explain, so no stamp is written.
    charge = _charge(description="WOOLIES", category=None)
    lam.rule_ingest.apply(
        [charge], rule_repo=FakeRuleStore([_rule("COLES", "groceries")]),
        category_repo=FakeCategoryRepo(["groceries"]))
    assert "filed_by_rule" not in charge


def test_filing_recomputes_counts_to_budget(lam):
    # A rule that files into a NON-budget category must flip counts_to_budget off. The charge
    # starts counting (True); after filing to TRANSFER_OUT it must not count.
    charge = _charge(description="PAYID TO MUM", category=None, counts_to_budget=True)
    lam.rule_ingest.apply(
        [charge], rule_repo=FakeRuleStore([_rule("PAYID", "TRANSFER_OUT")]),
        category_repo=FakeCategoryRepo(["TRANSFER_OUT"]))
    assert charge["category"] == "TRANSFER_OUT"
    assert charge["counts_to_budget"] is False        # FAIL-ON-REVERT: recompute line removed -> True


def test_disagreeing_rules_leave_the_charge_unfiled_and_log_both(lam, caplog):
    charge = _charge(description="COLES EXPRESS", category=None)
    rules = [_rule("COLES", "groceries", rule_id="r-groceries"),
             _rule("COLES EXPRESS", "petrol", rule_id="r-petrol")]
    with caplog.at_level(logging.INFO):
        lam.rule_ingest.apply(
            [charge], rule_repo=FakeRuleStore(rules), category_repo=FakeCategoryRepo(["groceries", "petrol"]))
    assert charge["category"] is None                 # conflict -> never silently decided
    assert "r-groceries" in caplog.text and "r-petrol" in caplog.text


def test_rule_to_a_deleted_category_is_skipped(lam):
    # The rule's category is not in the taxonomy (deleted) -> _skip_reason drops it, so the charge
    # is left unfiled rather than filed to a dangling id. FAIL-ON-REVERT: without the skip filter,
    # decide would file it to "ghost".
    charge = _charge(description="COLES", category=None)
    lam.rule_ingest.apply(
        [charge], rule_repo=FakeRuleStore([_rule("COLES", "ghost-category")]),
        category_repo=FakeCategoryRepo(["groceries"]))
    assert charge["category"] is None


def test_rules_read_failure_leaves_the_charge_unfiled_and_logs(lam, caplog):
    charge = _charge(description="COLES", category=None)
    with caplog.at_level(logging.ERROR):
        rows, is_unfiled = lam.rule_ingest.apply(
            [charge], rule_repo=FakeRuleStore(error=True), category_repo=FakeCategoryRepo(["groceries"]))
    assert rows[0]["category"] is None                 # best-effort: charge still lands, unfiled
    assert is_unfiled is None                          # read failed: no gate for the carry
    assert "could not read rules" in caplog.text      # FAIL-ON-REVERT: no try/except -> raises


def test_an_already_filed_charge_is_left_alone(lam):
    # The charge already carries a live category; a matching rule must not re-file it.
    charge = _charge(description="COLES", category="eating-out")
    lam.rule_ingest.apply(
        [charge], rule_repo=FakeRuleStore([_rule("COLES", "groceries")]),
        category_repo=FakeCategoryRepo(["groceries", "eating-out"]))
    assert charge["category"] == "eating-out"


def test_only_the_matching_charge_in_a_batch_is_filed(lam):
    hit = _charge(txn_id="t1", description="COLES 1", category=None)
    miss = _charge(txn_id="t2", description="ALDI 2", category=None)
    lam.rule_ingest.apply(
        [hit, miss], rule_repo=FakeRuleStore([_rule("COLES", "groceries")]),
        category_repo=FakeCategoryRepo(["groceries"]))
    assert hit["category"] == "groceries"
    assert miss["category"] is None


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
    seed = lam.banksync.BankSyncClient.normalise(_raw("t9", description="COLES 123", pending=True))
    seed["category"] = "eating-out"
    seed["counts_to_budget"] = True
    repo.insert_or_reconcile([seed])
    assert _stored(repo, "t9")["category"] == "eating-out"

    handler.process_transaction(
        {"id": "evt2", "data": [_raw("t9", description="COLES 123", pending=True)]}, repo)
    assert _stored(repo, "t9")["category"] == "eating-out"    # carry wins over the rule's groceries
