"""WHIT-559: the "spread this bill" action through the HTTP rules routes.

A spread rule captures the recurring bill it will spread at CREATE time, grounded in the charges the
rule itself matches (via the WHIT-568 detector). This suite covers the route seams: a spread create
captures the detected amount + cadence; a rule that matches no single recurring bill is a 422; a
second spreading rule on a category is a 409; and the flag/captured fields round-trip through
rule_book.rule_from_row. The repo-layer threading is pinned in tests/shared/test_repository_rule.py.

Driven through lambda_handler with the real RuleRepository and TransactionRepository over one
seeded FakeTable injected.
"""

import json
from decimal import Decimal
from functools import partial

import pytest

from _api_event import api_event
from _feed_fakes import SPENDING, Repos, _row, _rule, inject_rule_routes


_CATEGORIES = ("groceries", "subscriptions", "insurance")


_inject = partial(inject_rule_routes, categories=_CATEGORIES)


def _monthly(merchant, description, amount, months=("01", "02", "03", "04")):
    return [_row(SPENDING, f"2026-{m}-05", f"{merchant}-{m}", merchant_name=merchant,
                 description=description, amount=Decimal(str(amount)), category="subscriptions")
            for m in months]


def test_spread_create_captures_the_detected_bill(handler, monkeypatch):
    repo = Repos()
    _inject(handler, monkeypatch, repo,
            transactions={SPENDING: _monthly("NETFLIX", "NETFLIX SUBSCRIPTION", "-15.99")})
    resp = handler.lambda_handler(
        api_event("POST", "/rules",
               {"value": "NETFLIX", "categoryId": "subscriptions", "spread": True}), None)
    body = json.loads(resp["body"])
    assert resp["statusCode"] == 201
    assert body["spread"] is True
    assert body["spreadAmount"] == 15.99            # Decimal cents, JSON number
    assert body["spreadGapDays"] == 31              # gaps 31/28/31 → median 31
    minted = repo.minted_rules()[0]
    assert minted["spread"] is True
    assert minted["spread_amount"] == Decimal("15.99")
    assert minted["spread_gap_days"] == 31
    assert minted["spread_seeded"] is False


_NETFLIX_ONCE = [_row(SPENDING, "2026-01-05", "n1", merchant_name="NETFLIX",
                      description="NETFLIX SUBSCRIPTION", amount=Decimal("-15.99"),
                      category="subscriptions")]
_TWO_BILLS = (_monthly("CITY GYM", "CITY GYM PAYMENT", "-40.00")
              + _monthly("ACME INSURANCE", "ACME INSURANCE PAYMENT", "-90.00"))


@pytest.mark.parametrize("charges, body", [
    # The rule matches a single charge: not a recurring bill, nothing to capture.
    (_NETFLIX_ONCE, {"value": "NETFLIX"}),
    # A broad rule reaches two recurring merchants: no single amount to capture.
    (_TWO_BILLS, {"value": "PAYMENT"}),
    # An AND that matches no charge at all.
    (_monthly("NETFLIX", "NETFLIX SUBSCRIPTION", "-15.99"),
     {"logic": "all", "conditions": [
         {"field": "description", "operator": "contains", "value": "NETFLIX"},
         {"field": "description", "operator": "contains", "value": "GYMPASS"}]}),
])
def test_a_spread_rule_without_exactly_one_bill_is_rejected_422(handler, monkeypatch, charges,
                                                                 body):
    # FAIL-ON-REVERT: return a bill unconditionally and this stops rejecting.
    repo = Repos()
    _inject(handler, monkeypatch, repo, transactions={SPENDING: charges})
    resp = handler.lambda_handler(
        api_event("POST", "/rules", {**body, "categoryId": "subscriptions", "spread": True}), None)
    assert resp["statusCode"] == 422
    assert repo.minted_rules() == []


@pytest.mark.parametrize("body, charges, expected", [
    ({"value": "SPOTIFY", "categoryId": "subscriptions", "spread": True},
     _monthly("SPOTIFY", "SPOTIFY PREMIUM", "-12.99"), 409),
    ({"value": "ACME INSURANCE", "categoryId": "insurance", "spread": True},
     _monthly("ACME INSURANCE", "ACME INSURANCE PREMIUM", "-90.00"), 201),
    ({"value": "SPOTIFY", "categoryId": "subscriptions"}, [], 201),
])
def test_a_second_spreading_rule_on_a_category_is_rejected(handler, monkeypatch, body, charges,
                                                           expected):
    # At most one spreading rule per category (one spread plan per category). Only spread vs
    # spread on the SAME category clashes. FAIL-ON-REVERT: drop the per-category check and the
    # first row returns 201.
    existing = _rule("NETFLIX", "subscriptions", spread=True,
                     spread_amount=Decimal("15.99"), spread_gap_days=31)
    repo = Repos(rules=[existing])
    _inject(handler, monkeypatch, repo, transactions={SPENDING: charges})
    resp = handler.lambda_handler(api_event("POST", "/rules", body), None)
    assert resp["statusCode"] == expected
    assert len(repo.rule_repo.list_rules()) == (1 if expected == 409 else 2)


def test_editing_the_same_spreading_rule_is_not_a_self_clash(handler, monkeypatch):
    # The per-category check excludes the rule being edited, so re-saving it does not 409 against
    # itself.
    existing = _rule("NETFLIX", "subscriptions", spread=True,
                     spread_amount=Decimal("15.99"), spread_gap_days=31)
    repo = Repos(rules=[existing])
    rule_id = repo.rule_repo.list_rules()[0]["id"]
    _inject(handler, monkeypatch, repo,
            transactions={SPENDING: _monthly("NETFLIX", "NETFLIX SUBSCRIPTION", "-15.99")})
    resp = handler.lambda_handler(
        api_event("PUT", "/rules/x", {"value": "NETFLIX", "categoryId": "subscriptions",
                                   "spread": True}, path_params={"id": rule_id}), None)
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"])["spread"] is True


def test_reposting_an_identical_spread_rule_is_idempotent_201(handler, monkeypatch):
    # FAIL-ON-REVERT for the create-path self-exclude: the SAME spread rule re-POSTed must dedup to
    # 201 (one row), not 409 against itself. Pass exclude_id=None to the per-category check and this
    # reddens (the rule matches itself → 409).
    existing = _rule("NETFLIX", "subscriptions", spread=True,
                     spread_amount=Decimal("15.99"), spread_gap_days=31)
    repo = Repos(rules=[existing])
    _inject(handler, monkeypatch, repo,
            transactions={SPENDING: _monthly("NETFLIX", "NETFLIX SUBSCRIPTION", "-15.99")})
    resp = handler.lambda_handler(
        api_event("POST", "/rules",
               {"value": "NETFLIX", "categoryId": "subscriptions", "spread": True}), None)
    assert resp["statusCode"] == 201
    assert json.loads(resp["body"])["spread"] is True
    assert len(repo.rule_repo.list_rules()) == 1


def test_spread_and_budget_excluded_together_is_rejected(handler, monkeypatch):
    # The two actions contradict (keep out of budget vs spread into it) → 400, never stored.
    repo = Repos()
    _inject(handler, monkeypatch, repo,
            transactions={SPENDING: _monthly("NETFLIX", "NETFLIX SUBSCRIPTION", "-15.99")})
    resp = handler.lambda_handler(
        api_event("POST", "/rules", {"value": "NETFLIX", "categoryId": "subscriptions",
                                  "spread": True, "budgetExcluded": True}), None)
    assert resp["statusCode"] == 400
    assert repo.minted_rules() == []


def test_turning_spread_off_through_put_clears_the_captured_bill(handler, monkeypatch):
    existing = _rule("NETFLIX", "subscriptions", spread=True,
                     spread_amount=Decimal("15.99"), spread_gap_days=31)
    repo = Repos(rules=[existing])
    rule_id = repo.rule_repo.list_rules()[0]["id"]
    repo.rule_repo.mark_spread_seeded(rule_id)
    _inject(handler, monkeypatch, repo, transactions={})
    resp = handler.lambda_handler(
        api_event("PUT", "/rules/x",
               {"value": "NETFLIX", "categoryId": "subscriptions", "spread": False},
               path_params={"id": rule_id}), None)
    body = json.loads(resp["body"])
    assert resp["statusCode"] == 200
    assert body["spread"] is False
    assert body["spreadAmount"] is None and body["spreadGapDays"] is None
    row = repo.rule_repo.get_rule(rule_id)
    assert "spread_amount" not in row and "spread_gap_days" not in row and "spread_seeded" not in row


def test_toggling_spread_on_an_existing_plain_rule_captures_and_arms(handler, monkeypatch):
    existing = _rule("NETFLIX", "subscriptions", spread=False)
    repo = Repos(rules=[existing])
    rule_id = repo.rule_repo.list_rules()[0]["id"]
    _inject(handler, monkeypatch, repo,
            transactions={SPENDING: _monthly("NETFLIX", "NETFLIX SUBSCRIPTION", "-15.99")})
    resp = handler.lambda_handler(
        api_event("PUT", "/rules/x",
               {"value": "NETFLIX", "categoryId": "subscriptions", "spread": True},
               path_params={"id": rule_id}), None)
    body = json.loads(resp["body"])
    assert resp["statusCode"] == 200
    assert body["spread"] is True and body["spreadAmount"] == 15.99 and body["spreadGapDays"] == 31
    assert repo.rule_repo.get_rule(rule_id)["spread_seeded"] is False


def test_text_edit_of_a_spread_rule_recaptures_and_rearms_through_the_route(handler, monkeypatch):
    existing = _rule("NETFLIX", "subscriptions", spread=True,
                     spread_amount=Decimal("15.99"), spread_gap_days=31)
    repo = Repos(rules=[existing])
    old_id = repo.rule_repo.list_rules()[0]["id"]
    repo.rule_repo.mark_spread_seeded(old_id)
    _inject(handler, monkeypatch, repo,
            transactions={SPENDING: _monthly("SPOTIFY", "SPOTIFY PREMIUM", "-12.99")})
    resp = handler.lambda_handler(
        api_event("PUT", "/rules/x",
               {"value": "SPOTIFY", "categoryId": "subscriptions", "spread": True},
               path_params={"id": old_id}), None)
    body = json.loads(resp["body"])
    assert resp["statusCode"] == 200
    assert body["spread"] is True and body["spreadAmount"] == 12.99
    assert repo.rule_repo.get_rule(old_id) is None                      # old row retired
    new_id = repo.rule_repo.list_rules()[0]["id"]
    assert repo.rule_repo.get_rule(new_id)["spread_seeded"] is False     # re-armed


def test_an_unrelated_edit_preserves_the_captured_amount_without_redetecting(handler, monkeypatch):
    # The amount is frozen at create. Editing ONLY the category (match text unchanged) must keep the
    # stored amount and NOT re-run the detector — proven here with an EMPTY transaction store, where a
    # re-detect would find no bill and 422. FAIL-ON-REVERT: drop the `preserved` path in
    # update_rule_route and this edit 422s on the empty history.
    existing = _rule("NETFLIX", "subscriptions", spread=True,
                     spread_amount=Decimal("15.99"), spread_gap_days=31)
    repo = Repos(rules=[existing])
    rule_id = repo.rule_repo.list_rules()[0]["id"]
    _inject(handler, monkeypatch, repo, transactions={})   # history aged out / empty
    resp = handler.lambda_handler(
        api_event("PUT", "/rules/x",
               {"value": "NETFLIX", "categoryId": "groceries", "spread": True},
               path_params={"id": rule_id}), None)
    body = json.loads(resp["body"])
    assert resp["statusCode"] == 200
    assert body["categoryId"] == "groceries"
    assert body["spreadAmount"] == 15.99 and body["spreadGapDays"] == 31   # preserved, not re-detected
