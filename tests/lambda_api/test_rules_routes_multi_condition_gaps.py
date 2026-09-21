"""WHIT-561 GAP tests for POST/PUT /rules multi-condition validation + mapping.

Complements test_rules_routes_multi_condition.py. Probes the validator seams that suite doesn't:
  * amount given as a JSON number (int / float) -> normalised to a canonical string
  * amount as a JSON bool / null / negative-number -> 400
  * a TEXT condition value given as a non-string (number) -> 400
  * a non-object condition, and a missing value key -> 400
  * category-equals (raw enum) + amount accepted (category value NOT floored)
  * direction=credit round-trips
  * the value floor is NOT applied to amount/account (non-substring) conditions
  * a single-condition create still emits conditions=None/logic=None (regression)
"""

import json

from _feed_fakes import FakeCategoryRepo, WritableFeedRepo
from _rule_fakes import FakeRuleRepo


_CATEGORIES = ("transport", "groceries")


def _event(method, path, body):
    return {"rawPath": path, "requestContext": {"http": {"method": method}},
            "body": json.dumps(body)}


def _inject(handler, monkeypatch, repo, categories=_CATEGORIES):
    monkeypatch.setattr(handler, "RuleRepository", lambda: repo)
    monkeypatch.setattr(handler, "CategoryRepository", lambda: FakeCategoryRepo(categories))
    monkeypatch.setattr(handler, "TransactionRepository", lambda: WritableFeedRepo({}))


def _post(handler, monkeypatch, repo, conditions, logic="all", category_id="transport"):
    body = {"conditions": conditions, "logic": logic, "categoryId": category_id}
    return handler.lambda_handler(_event("POST", "/rules", body), None)


# --- amount as a JSON number vs string --------------------------------------------------------


def test_amount_as_a_json_int_is_normalised_to_a_string(handler, monkeypatch):
    # [G-r1] The client may send `"value": 30` (a JSON number), not `"30"`. The validator does
    # Decimal(str(value)) and STORES the canonical string, so the engine (also str()-based) and the
    # id hash both see a stable value.
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)
    resp = _post(handler, monkeypatch, repo,
                 [{"field": "amount", "operator": "less_than", "value": 30}])
    out = json.loads(resp["body"])
    assert resp["statusCode"] == 201
    assert out["conditions"][0]["value"] == "30"
    assert isinstance(out["conditions"][0]["value"], str)


def test_amount_as_a_json_float_is_normalised_to_a_string(handler, monkeypatch):
    # [G-r1b] A float 30.5 normalises to "30.5".
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)
    resp = _post(handler, monkeypatch, repo,
                 [{"field": "amount", "operator": "greater_than", "value": 30.5}])
    out = json.loads(resp["body"])
    assert resp["statusCode"] == 201
    assert out["conditions"][0]["value"] == "30.5"


def test_amount_as_a_json_bool_is_400(handler, monkeypatch):
    # [G-r2] True must NOT be coerced to a number (str(True) == "True" -> InvalidOperation -> 400).
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)
    resp = _post(handler, monkeypatch, repo,
                 [{"field": "amount", "operator": "less_than", "value": True}])
    assert resp["statusCode"] == 400
    assert repo.minted == []


def test_amount_as_json_null_is_400(handler, monkeypatch):
    # [G-r2b] null -> str(None) == "None" -> InvalidOperation -> 400 (not a silent 0).
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)
    resp = _post(handler, monkeypatch, repo,
                 [{"field": "amount", "operator": "less_than", "value": None}])
    assert resp["statusCode"] == 400


def test_negative_amount_number_is_400(handler, monkeypatch):
    # [G-r2c] amount is PLAIN POSITIVE dollars; a negative number is rejected (matched against abs).
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)
    resp = _post(handler, monkeypatch, repo,
                 [{"field": "amount", "operator": "less_than", "value": -5}])
    assert resp["statusCode"] == 400


# --- text conditions: value must be a string --------------------------------------------------


def test_text_condition_value_as_a_number_is_400(handler, monkeypatch):
    # [G-r3] merchant/description values must be strings; a JSON number is rejected, not stringified.
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)
    resp = _post(handler, monkeypatch, repo,
                 [{"field": "merchant", "operator": "contains", "value": 42}])
    assert resp["statusCode"] == 400


def test_non_object_condition_is_400(handler, monkeypatch):
    # [G-r3b] Each condition must be an object.
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)
    resp = _post(handler, monkeypatch, repo, ["merchant contains uber"])
    assert resp["statusCode"] == 400


def test_condition_missing_value_key_is_400(handler, monkeypatch):
    # [G-r3c] A condition with no value at all -> 400 (text path sees None, not a string).
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)
    resp = _post(handler, monkeypatch, repo,
                 [{"field": "merchant", "operator": "contains"}])
    assert resp["statusCode"] == 400


# --- category-equals + amount accepted; direction=credit round-trips --------------------------


def test_category_equals_plus_amount_is_accepted(handler, monkeypatch):
    # [G-r4] A raw-enum `category equals FOOD_AND_DRINK` + amount is a legal multi rule. The
    # category VALUE is not the app's categoryId, so it is not taxonomy-checked; only the rule's
    # top-level categoryId is.
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)
    resp = _post(handler, monkeypatch, repo,
                 [{"field": "category", "operator": "equals", "value": "FOOD_AND_DRINK"},
                  {"field": "amount", "operator": "less_than", "value": 30}])
    out = json.loads(resp["body"])
    assert resp["statusCode"] == 201
    assert out["conditions"][0]["value"] == "FOOD_AND_DRINK"


def test_direction_credit_round_trips(handler, monkeypatch):
    # [G-r5] direction=credit is a legal value and round-trips.
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)
    resp = _post(handler, monkeypatch, repo,
                 [{"field": "direction", "operator": "is", "value": "credit"}])
    out = json.loads(resp["body"])
    assert resp["statusCode"] == 201
    assert out["conditions"][0]["value"] == "credit"


# --- the value floor applies only to substring (contains) fields ------------------------------


def test_value_floor_not_applied_to_amount_or_account(handler, monkeypatch):
    # [G-r6] The value floor (rule_value_is_safe) guards SUBSTRING over-match, so it applies only to
    # `contains` fields (description, merchant). amount and account match exactly, not by substring,
    # so a tiny amount and a short-but-exact account id are accepted. FAIL-ON-REVERT would be a change
    # that started flooring exact-match fields -> this reddens.
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)
    resp = _post(handler, monkeypatch, repo,
                 [{"field": "account", "operator": "equals", "value": "a1"},
                  {"field": "amount", "operator": "less_than", "value": 1}])
    assert resp["statusCode"] == 201


def test_value_floor_still_bites_description_contains_inside_a_multi(handler, monkeypatch):
    # [G-r6b] guard the other side: a near-empty description-contains condition IS floored.
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)
    resp = _post(handler, monkeypatch, repo,
                 [{"field": "description", "operator": "contains", "value": "a"},
                  {"field": "amount", "operator": "less_than", "value": 30}])
    assert resp["statusCode"] == 400


# --- regression: single-condition create is byte-identical to before --------------------------


def test_single_condition_create_emits_null_conditions(handler, monkeypatch):
    # [G-r7] A legacy body {value, categoryId} still validates to conditions=None/logic=None and
    # stores no conditions -> the client shape carries conditions:None, logic:None.
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)
    resp = handler.lambda_handler(
        _event("POST", "/rules", {"value": "COLES", "categoryId": "groceries"}), None)
    out = json.loads(resp["body"])
    assert resp["statusCode"] == 201
    assert out["conditions"] is None and out["logic"] is None
    assert "conditions" not in repo.minted[0]        # stored row byte-identical to legacy
