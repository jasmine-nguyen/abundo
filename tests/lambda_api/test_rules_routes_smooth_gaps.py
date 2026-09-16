"""WHIT-559 GAPS — adversarial route seams for the "smooth this bill" rule action.

The implementer's tests/lambda_api/test_rules_routes_smooth.py pins the create happy path, the two
422s, the 409, the self-edit-not-a-clash, the idempotent re-POST, the smooth+budgetExcluded reject,
and the non-smooth path. This suite adds the seams they did NOT cover, all driven through
lambda_handler:

  * smooth non-boolean -> 400 (the _validate_rule_body guard runs BEFORE any capture);
  * the 409 boundary is smooth-vs-smooth on the SAME category only — a different category and a
    non-smooth second rule are both allowed;
  * turning smooth OFF through PUT clears amount/gap/seeded end-to-end;
  * toggling smooth ON on an existing plain rule captures + arms seeded False;
  * a text edit (id move) of a smooth rule re-captures + re-arms through the route;
  * an UNRELATED edit (category only, text unchanged) PRESERVES the captured amount and does not
    re-detect (so it never 422s when the bill history has aged out);
  * capture is grounded in the rule's matched charges: income-only (amount>0) and variable-amount
    merchants both fail to a 422; the captured amount is the detector MEDIAN, not the first/mean;
  * a multi-condition (WHIT-541) smooth rule captures + round-trips, and an AND that matches no
    recurring charge is a 422;
  * smoothAmount serialises as a JSON number (float) and smoothGapDays as an int.

Reuses the feed fakes (_row/SPENDING/WritableFeedRepo/FakeCategoryRepo) + FakeRuleRepo exactly as
the sibling suite does. Registered in tests/shared/test_fakes_invariants.py under BOTH the feed and
rule domains.
"""

import json
from decimal import Decimal

from _feed_fakes import SPENDING, _row, FakeCategoryRepo, WritableFeedRepo
from _rule_fakes import FakeRuleRepo


_CATEGORIES = ("groceries", "subscriptions", "insurance")


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


def _charges(merchant, description, amounts, months=("01", "02", "03", "04"),
             category="subscriptions"):
    """One charge per month; `amounts` is a same-length list of signed dollar strings."""
    return [_row(SPENDING, f"2026-{m}-05", f"{merchant}-{m}", merchant_name=merchant,
                 description=description, amount=Decimal(a), category=category)
            for m, a in zip(months, amounts)]


def _fixed(merchant, description, amount, months=("01", "02", "03", "04")):
    return _charges(merchant, description, [amount] * len(months), months)


# --- the smooth:true validation guard ----------------------------------------------------------

def test_smooth_non_boolean_is_a_400(handler, monkeypatch):
    # FAIL-ON-REVERT for the _validate_rule_body guard: a non-bool `smooth` is rejected at
    # validation, BEFORE the detector ever runs. Delete the isinstance(smooth, bool) check and the
    # truthy string "yes" flows through as smooth -> this stops being a 400.
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo, transactions={})
    resp = handler.lambda_handler(
        _event("POST", "/rules",
               {"value": "NETFLIX", "categoryId": "subscriptions", "smooth": "yes"}), None)
    assert resp["statusCode"] == 400
    assert "smooth" in json.loads(resp["body"])["error"]
    assert repo.minted == []


# --- the per-category 409 boundary: only smooth-vs-smooth on the SAME category clashes ----------

def test_a_second_smoothing_rule_on_a_different_category_is_allowed(handler, monkeypatch):
    existing = _rule("NETFLIX", "subscriptions", smooth=True,
                     smooth_amount=Decimal("15.99"), smooth_gap_days=31)
    repo = FakeRuleRepo(rules=[existing])
    _inject(handler, monkeypatch, repo,
            transactions={SPENDING: _fixed("ACME INSURANCE", "ACME INSURANCE PREMIUM", "-90.00")})
    resp = handler.lambda_handler(
        _event("POST", "/rules",
               {"value": "ACME INSURANCE", "categoryId": "insurance", "smooth": True}), None)
    assert resp["statusCode"] == 201
    assert json.loads(resp["body"])["smooth"] is True
    assert len(repo.list_rules()) == 2


def test_a_non_smooth_second_rule_on_the_same_category_is_allowed(handler, monkeypatch):
    existing = _rule("NETFLIX", "subscriptions", smooth=True,
                     smooth_amount=Decimal("15.99"), smooth_gap_days=31)
    repo = FakeRuleRepo(rules=[existing])
    _inject(handler, monkeypatch, repo, transactions={})
    resp = handler.lambda_handler(
        _event("POST", "/rules", {"value": "SPOTIFY", "categoryId": "subscriptions"}), None)
    assert resp["statusCode"] == 201
    assert json.loads(resp["body"])["smooth"] is False
    assert len(repo.list_rules()) == 2


# --- toggling smooth through PUT ---------------------------------------------------------------

def test_turning_smooth_off_through_put_clears_the_captured_bill(handler, monkeypatch):
    existing = _rule("NETFLIX", "subscriptions", smooth=True,
                     smooth_amount=Decimal("15.99"), smooth_gap_days=31)
    repo = FakeRuleRepo(rules=[existing])
    rule_id = repo.list_rules()[0]["id"]
    stored = repo.get_rule(rule_id)
    stored["smooth_seeded"] = True
    repo._rows[rule_id] = stored
    _inject(handler, monkeypatch, repo, transactions={})
    resp = handler.lambda_handler(
        _event("PUT", "/rules/x",
               {"value": "NETFLIX", "categoryId": "subscriptions", "smooth": False},
               path_params={"id": rule_id}), None)
    body = json.loads(resp["body"])
    assert resp["statusCode"] == 200
    assert body["smooth"] is False
    assert body["smoothAmount"] is None and body["smoothGapDays"] is None
    row = repo.get_rule(rule_id)
    assert "smooth_amount" not in row and "smooth_gap_days" not in row and "smooth_seeded" not in row


def test_toggling_smooth_on_an_existing_plain_rule_captures_and_arms(handler, monkeypatch):
    existing = _rule("NETFLIX", "subscriptions", smooth=False)
    repo = FakeRuleRepo(rules=[existing])
    rule_id = repo.list_rules()[0]["id"]
    _inject(handler, monkeypatch, repo,
            transactions={SPENDING: _fixed("NETFLIX", "NETFLIX SUBSCRIPTION", "-15.99")})
    resp = handler.lambda_handler(
        _event("PUT", "/rules/x",
               {"value": "NETFLIX", "categoryId": "subscriptions", "smooth": True},
               path_params={"id": rule_id}), None)
    body = json.loads(resp["body"])
    assert resp["statusCode"] == 200
    assert body["smooth"] is True and body["smoothAmount"] == 15.99 and body["smoothGapDays"] == 31
    assert repo.get_rule(rule_id)["smooth_seeded"] is False


def test_text_edit_of_a_smooth_rule_recaptures_and_rearms_through_the_route(handler, monkeypatch):
    existing = _rule("NETFLIX", "subscriptions", smooth=True,
                     smooth_amount=Decimal("15.99"), smooth_gap_days=31)
    repo = FakeRuleRepo(rules=[existing])
    old_id = repo.list_rules()[0]["id"]
    seeded = {**repo.get_rule(old_id), "smooth_seeded": True}
    repo._rows[old_id] = seeded
    _inject(handler, monkeypatch, repo,
            transactions={SPENDING: _fixed("SPOTIFY", "SPOTIFY PREMIUM", "-12.99")})
    resp = handler.lambda_handler(
        _event("PUT", "/rules/x",
               {"value": "SPOTIFY", "categoryId": "subscriptions", "smooth": True},
               path_params={"id": old_id}), None)
    body = json.loads(resp["body"])
    assert resp["statusCode"] == 200
    assert body["smooth"] is True and body["smoothAmount"] == 12.99
    assert repo.get_rule(old_id) is None                      # old row retired
    new_id = repo.list_rules()[0]["id"]
    assert repo.get_rule(new_id)["smooth_seeded"] is False     # re-armed


def test_an_unrelated_edit_preserves_the_captured_amount_without_redetecting(handler, monkeypatch):
    # The amount is frozen at create. Editing ONLY the category (match text unchanged) must keep the
    # stored amount and NOT re-run the detector — proven here with an EMPTY transaction store, where a
    # re-detect would find no bill and 422. FAIL-ON-REVERT: drop the `preserved` path in
    # update_rule_route and this edit 422s on the empty history.
    existing = _rule("NETFLIX", "subscriptions", smooth=True,
                     smooth_amount=Decimal("15.99"), smooth_gap_days=31)
    repo = FakeRuleRepo(rules=[existing])
    rule_id = repo.list_rules()[0]["id"]
    _inject(handler, monkeypatch, repo, transactions={})   # history aged out / empty
    resp = handler.lambda_handler(
        _event("PUT", "/rules/x",
               {"value": "NETFLIX", "categoryId": "groceries", "smooth": True},
               path_params={"id": rule_id}), None)
    body = json.loads(resp["body"])
    assert resp["statusCode"] == 200
    assert body["categoryId"] == "groceries"
    assert body["smoothAmount"] == 15.99 and body["smoothGapDays"] == 31   # preserved, not re-detected


# --- detector grounding: capture reflects the rule's matched charges ---------------------------

def test_income_only_matches_capture_no_bill_and_reject_422(handler, monkeypatch):
    repo = FakeRuleRepo()
    payroll = _charges("ACME PAYROLL", "ACME PAYROLL", ["2500.00"] * 4, category="income")
    _inject(handler, monkeypatch, repo, transactions={SPENDING: payroll})
    resp = handler.lambda_handler(
        _event("POST", "/rules",
               {"value": "PAYROLL", "categoryId": "subscriptions", "smooth": True}), None)
    assert resp["statusCode"] == 422
    assert repo.minted == []


def test_variable_amount_merchant_is_not_a_bill_422(handler, monkeypatch):
    repo = FakeRuleRepo()
    varying = _charges("CORNER CAFE", "CORNER CAFE", ["-10.00", "-50.00", "-90.00", "-95.00"])
    _inject(handler, monkeypatch, repo, transactions={SPENDING: varying})
    resp = handler.lambda_handler(
        _event("POST", "/rules",
               {"value": "CORNER CAFE", "categoryId": "subscriptions", "smooth": True}), None)
    assert resp["statusCode"] == 422
    assert repo.minted == []


def test_capture_is_the_detector_median_not_first_or_mean(handler, monkeypatch):
    # Amounts -40/-42/-44/-50 (all within 30% of the median): median = (42+44)/2 = 43, mean = 44,
    # first = 40. The captured smoothAmount must be 43.00 -> proves it's the median.
    repo = FakeRuleRepo()
    charges = _charges("ORIGIN ENERGY", "ORIGIN ENERGY", ["-40.00", "-42.00", "-44.00", "-50.00"])
    _inject(handler, monkeypatch, repo, transactions={SPENDING: charges})
    resp = handler.lambda_handler(
        _event("POST", "/rules",
               {"value": "ORIGIN ENERGY", "categoryId": "subscriptions", "smooth": True}), None)
    body = json.loads(resp["body"])
    assert resp["statusCode"] == 201
    assert body["smoothAmount"] == 43.0
    assert repo.minted[0]["smooth_amount"] == Decimal("43.00")


# --- multi-condition rules ---------------------------------------------------------------------

def test_multi_condition_smooth_rule_captures_and_round_trips(handler, monkeypatch):
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo,
            transactions={SPENDING: _fixed("NETFLIX", "NETFLIX SUBSCRIPTION", "-15.99")})
    resp = handler.lambda_handler(
        _event("POST", "/rules",
               {"categoryId": "subscriptions", "smooth": True, "logic": "all",
                "conditions": [{"field": "description", "operator": "contains", "value": "NETFLIX"},
                               {"field": "description", "operator": "contains",
                                "value": "SUBSCRIPTION"}]}), None)
    body = json.loads(resp["body"])
    assert resp["statusCode"] == 201
    assert body["smooth"] is True and body["smoothAmount"] == 15.99
    assert len(body["conditions"]) == 2
    assert repo.minted[0]["smooth_amount"] == Decimal("15.99")


def test_multi_condition_and_that_matches_no_single_bill_is_422(handler, monkeypatch):
    # The AND narrows the matched set to nothing recurring -> 422, grounded in the matched charges.
    # NETFLIX charges never carry "GYMPASS", so the AND matches zero charges (value clears the floor).
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo,
            transactions={SPENDING: _fixed("NETFLIX", "NETFLIX SUBSCRIPTION", "-15.99")})
    resp = handler.lambda_handler(
        _event("POST", "/rules",
               {"categoryId": "subscriptions", "smooth": True, "logic": "all",
                "conditions": [{"field": "description", "operator": "contains", "value": "NETFLIX"},
                               {"field": "description", "operator": "contains", "value": "GYMPASS"}]}),
        None)
    assert resp["statusCode"] == 422
    assert repo.minted == []


# --- serialisation -----------------------------------------------------------------------------

def test_smooth_fields_serialise_as_json_number_and_int(handler, monkeypatch):
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo,
            transactions={SPENDING: _fixed("NETFLIX", "NETFLIX SUBSCRIPTION", "-15.99")})
    resp = handler.lambda_handler(
        _event("POST", "/rules",
               {"value": "NETFLIX", "categoryId": "subscriptions", "smooth": True}), None)
    body = json.loads(resp["body"])
    assert isinstance(body["smoothAmount"], float)
    assert isinstance(body["smoothGapDays"], int) and not isinstance(body["smoothGapDays"], bool)
