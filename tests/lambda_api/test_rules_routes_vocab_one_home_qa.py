"""WHIT-608 QA — POST /rules validates against the shared rule vocabulary exactly as before the move:
every supported pair is accepted, everything else is a 400 naming the allowed values. Driven
through lambda_handler with the real RuleRepository over a FakeTable, like the other rules-route
suites."""

import json

import pytest

from _feed_fakes import Repos, inject_rule_routes

_PAIRS = [
    ("description", "contains"), ("description", "equals"),
    ("merchant", "contains"), ("merchant", "equals"),
    ("category", "equals"),
    ("account", "equals"),
    ("amount", "less_than"), ("amount", "less_than_or_equal"),
    ("amount", "greater_than"), ("amount", "greater_than_or_equal"),
    ("direction", "is"),
]
_VALUE = {"amount": "30", "direction": "debit"}


def _post(handler, monkeypatch, body):
    store = Repos()
    inject_rule_routes(handler, monkeypatch, store, ("transport",))
    event = {"rawPath": "/rules", "requestContext": {"http": {"method": "POST"}},
             "body": json.dumps(body)}
    response = handler.lambda_handler(event, None)
    return response["statusCode"], json.loads(response["body"])


def _conditions_body(conditions, logic="all"):
    return {"conditions": conditions, "logic": logic, "categoryId": "transport"}


# [A7] (P0) every pair the engine can run is accepted by the API (multi-condition shape).
@pytest.mark.parametrize("field,operator", _PAIRS)
def test_every_supported_pair_is_accepted(handler, monkeypatch, field, operator):
    condition = {"field": field, "operator": operator, "value": _VALUE.get(field, "UBER")}
    status, out = _post(handler, monkeypatch, _conditions_body([condition]))
    assert status == 201, out


# [A8] (P0) a pair outside the vocabulary is a 400 naming the field's allowed operators.
def test_unsupported_pair_is_400_listing_the_allowed_operators(handler, monkeypatch):
    condition = {"field": "direction", "operator": "equals", "value": "debit"}
    status, out = _post(handler, monkeypatch, _conditions_body([condition]))
    assert status == 400
    assert out["error"] == "operator for direction must be one of ['is']"


# [A9] (P0) an unknown field is a 400 listing every field.
def test_unknown_field_is_400_listing_every_field(handler, monkeypatch):
    condition = {"field": "payee", "operator": "equals", "value": "X"}
    status, out = _post(handler, monkeypatch, _conditions_body([condition]))
    assert status == 400
    assert out["error"] == (
        "field must be one of ['account', 'amount', 'category', 'description', 'direction', 'merchant']"
    )


# [A10] (P1) "any" is accepted; an unknown logic is a 400 naming all/any.
def test_logic_any_accepted_and_unknown_logic_rejected(handler, monkeypatch):
    condition = {"field": "merchant", "operator": "contains", "value": "UBER"}
    status, _out = _post(handler, monkeypatch, _conditions_body([condition], logic="any"))
    assert status == 201
    status, out = _post(handler, monkeypatch, _conditions_body([condition], logic="xor"))
    assert status == 400
    assert out["error"] == "logic must be one of ['all', 'any']"


# [A11] (P1) direction values still come from the shared RULE_DIRECTIONS.
def test_direction_credit_accepted_and_unknown_direction_rejected(handler, monkeypatch):
    status, _out = _post(handler, monkeypatch, _conditions_body(
        [{"field": "direction", "operator": "is", "value": "credit"}]))
    assert status == 201
    status, out = _post(handler, monkeypatch, _conditions_body(
        [{"field": "direction", "operator": "is", "value": "sideways"}]))
    assert status == 400
    assert out["error"] == "direction value must be one of ['credit', 'debit']"


# [A12] (P1) the legacy single-condition create still validates against the shared vocabulary.
def test_legacy_single_condition_create_uses_the_shared_vocabulary(handler, monkeypatch):
    status, _out = _post(handler, monkeypatch, {
        "field": "merchant", "operator": "equals", "value": "UBER", "categoryId": "transport"})
    assert status == 201
    status, out = _post(handler, monkeypatch, {
        "field": "amount", "operator": "contains", "value": "30", "categoryId": "transport"})
    assert status == 400, out
