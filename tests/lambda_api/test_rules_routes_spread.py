"""WHIT-559: the "spread this bill" action through the HTTP rules routes.

A spread rule captures the recurring bill it will spread at CREATE time, grounded in the charges the
rule itself matches (via the WHIT-568 detector). This suite covers the route seams: a spread create
captures the detected amount + cadence; a rule that matches no single recurring bill is a 422; a
second spreading rule on a category is a 409; and the flag/captured fields round-trip through
_rule_to_client. The repo-layer threading is pinned in tests/shared/test_repository_rule.py.

Driven through lambda_handler with a FakeRuleRepo + a seeded transaction repo injected.
"""

import json
from decimal import Decimal

from _feed_fakes import SPENDING, _row, FakeCategoryRepo, WritableFeedRepo
from _rule_fakes import FakeRuleRepo


_CATEGORIES = ("groceries", "subscriptions")


def _rule(value, category_id="subscriptions", **kw):
    return {"field": "description", "operator": "contains", "value": value,
            "category_id": category_id, **kw}


def _event(method, path, body=None, path_params=None):
    event = {"rawPath": path, "requestContext": {"http": {"method": method}}}
    if body is not None:
        event["body"] = json.dumps(body)
    if path_params is not None:
        event["pathParameters"] = path_params
    return event


def _inject(handler, monkeypatch, rule_repo, transactions=None, categories=_CATEGORIES):
    monkeypatch.setattr(handler, "RuleRepository", lambda: rule_repo)
    monkeypatch.setattr(handler, "CategoryRepository", lambda: FakeCategoryRepo(categories))
    monkeypatch.setattr(
        handler, "TransactionRepository", lambda: WritableFeedRepo(transactions or {}))


def _monthly(merchant, description, amount, months=("01", "02", "03", "04")):
    return [_row(SPENDING, f"2026-{m}-05", f"{merchant}-{m}", merchant_name=merchant,
                 description=description, amount=Decimal(str(amount)), category="subscriptions")
            for m in months]


def test_spread_create_captures_the_detected_bill(handler, monkeypatch):
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo,
            transactions={SPENDING: _monthly("NETFLIX", "NETFLIX SUBSCRIPTION", "-15.99")})
    resp = handler.lambda_handler(
        _event("POST", "/rules",
               {"value": "NETFLIX", "categoryId": "subscriptions", "spread": True}), None)
    body = json.loads(resp["body"])
    assert resp["statusCode"] == 201
    assert body["spread"] is True
    assert body["spreadAmount"] == 15.99            # Decimal cents, JSON number
    assert body["spreadGapDays"] == 31              # gaps 31/28/31 → median 31
    minted = repo.minted[0]
    assert minted["spread"] is True
    assert minted["spread_amount"] == Decimal("15.99")
    assert minted["spread_gap_days"] == 31
    assert minted["spread_seeded"] is False


def test_spread_create_with_no_recurring_bill_is_rejected(handler, monkeypatch):
    # The rule matches charges, but they are not a recurring bill (a single charge) → nothing to
    # capture → 422. FAIL-ON-REVERT: return a bill unconditionally and this stops rejecting.
    repo = FakeRuleRepo()
    one_off = [_row(SPENDING, "2026-01-05", "n1", merchant_name="NETFLIX",
                    description="NETFLIX SUBSCRIPTION", amount=Decimal("-15.99"),
                    category="subscriptions")]
    _inject(handler, monkeypatch, repo, transactions={SPENDING: one_off})
    resp = handler.lambda_handler(
        _event("POST", "/rules",
               {"value": "NETFLIX", "categoryId": "subscriptions", "spread": True}), None)
    assert resp["statusCode"] == 422
    assert repo.minted == []


def test_spread_create_matching_more_than_one_bill_is_rejected(handler, monkeypatch):
    # A broad rule ("...PAYMENT") reaches two distinct recurring merchants → no single amount to
    # capture → 422, be more specific.
    repo = FakeRuleRepo()
    charges = (_monthly("CITY GYM", "CITY GYM PAYMENT", "-40.00")
               + _monthly("ACME INSURANCE", "ACME INSURANCE PAYMENT", "-90.00"))
    _inject(handler, monkeypatch, repo, transactions={SPENDING: charges})
    resp = handler.lambda_handler(
        _event("POST", "/rules",
               {"value": "PAYMENT", "categoryId": "subscriptions", "spread": True}), None)
    assert resp["statusCode"] == 422
    assert repo.minted == []


def test_spread_create_matching_a_named_and_a_nameless_bill_is_rejected(handler, monkeypatch):
    # WHIT-569: a rule whose matched history holds a NAMED recurring bill AND a NAMELESS recurring
    # direct debit (now detected by the stem pass) reaches two bills → 422, be more specific. Fail-safe:
    # the app refuses rather than silently capturing only the named amount.
    repo = FakeRuleRepo()
    named = _monthly("ORIGIN ENERGY", "ORIGIN ENERGY DIRECT DEBIT", "-50.00")
    nameless = [_row(SPENDING, f"2026-{m}-12", f"dd-{m}", merchant_name="",
                     description="RENT DIRECT DEBIT 4471", amount=Decimal("-1800.00"),
                     category="subscriptions")
                for m in ("01", "02", "03", "04")]
    _inject(handler, monkeypatch, repo, transactions={SPENDING: named + nameless})
    resp = handler.lambda_handler(
        _event("POST", "/rules",
               {"value": "DIRECT DEBIT", "categoryId": "subscriptions", "spread": True}), None)
    assert resp["statusCode"] == 422
    assert repo.minted == []


def test_a_second_spreading_rule_on_a_category_is_rejected(handler, monkeypatch):
    # At most one spreading rule per category (one spread plan per category). FAIL-ON-REVERT: drop
    # the per-category check and this returns 201.
    existing = _rule("NETFLIX", "subscriptions", spread=True,
                     spread_amount=Decimal("15.99"), spread_gap_days=31)
    repo = FakeRuleRepo(rules=[existing])
    _inject(handler, monkeypatch, repo,
            transactions={SPENDING: _monthly("SPOTIFY", "SPOTIFY PREMIUM", "-12.99")})
    resp = handler.lambda_handler(
        _event("POST", "/rules",
               {"value": "SPOTIFY", "categoryId": "subscriptions", "spread": True}), None)
    assert resp["statusCode"] == 409
    assert len(repo.list_rules()) == 1              # nothing minted


def test_editing_the_same_spreading_rule_is_not_a_self_clash(handler, monkeypatch):
    # The per-category check excludes the rule being edited, so re-saving it does not 409 against
    # itself.
    existing = _rule("NETFLIX", "subscriptions", spread=True,
                     spread_amount=Decimal("15.99"), spread_gap_days=31)
    repo = FakeRuleRepo(rules=[existing])
    rule_id = repo.list_rules()[0]["id"]
    _inject(handler, monkeypatch, repo,
            transactions={SPENDING: _monthly("NETFLIX", "NETFLIX SUBSCRIPTION", "-15.99")})
    resp = handler.lambda_handler(
        _event("PUT", "/rules/x", {"value": "NETFLIX", "categoryId": "subscriptions",
                                   "spread": True}, path_params={"id": rule_id}), None)
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"])["spread"] is True


def test_reposting_an_identical_spread_rule_is_idempotent_201(handler, monkeypatch):
    # FAIL-ON-REVERT for the create-path self-exclude: the SAME spread rule re-POSTed must dedup to
    # 201 (one row), not 409 against itself. Pass exclude_id=None to the per-category check and this
    # reddens (the rule matches itself → 409).
    existing = _rule("NETFLIX", "subscriptions", spread=True,
                     spread_amount=Decimal("15.99"), spread_gap_days=31)
    repo = FakeRuleRepo(rules=[existing])
    _inject(handler, monkeypatch, repo,
            transactions={SPENDING: _monthly("NETFLIX", "NETFLIX SUBSCRIPTION", "-15.99")})
    resp = handler.lambda_handler(
        _event("POST", "/rules",
               {"value": "NETFLIX", "categoryId": "subscriptions", "spread": True}), None)
    assert resp["statusCode"] == 201
    assert json.loads(resp["body"])["spread"] is True
    assert len(repo.list_rules()) == 1


def test_spread_and_budget_excluded_together_is_rejected(handler, monkeypatch):
    # The two actions contradict (keep out of budget vs spread into it) → 400, never stored.
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo,
            transactions={SPENDING: _monthly("NETFLIX", "NETFLIX SUBSCRIPTION", "-15.99")})
    resp = handler.lambda_handler(
        _event("POST", "/rules", {"value": "NETFLIX", "categoryId": "subscriptions",
                                  "spread": True, "budgetExcluded": True}), None)
    assert resp["statusCode"] == 400
    assert repo.minted == []


def test_non_spread_create_never_touches_the_detector(handler, monkeypatch):
    # A plain rule creates with an empty transaction store — the capture only runs when spread.
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo, transactions={})
    resp = handler.lambda_handler(
        _event("POST", "/rules", {"value": "COLES", "categoryId": "groceries"}), None)
    body = json.loads(resp["body"])
    assert resp["statusCode"] == 201
    assert body["spread"] is False
    assert body["spreadAmount"] is None and body["spreadGapDays"] is None
