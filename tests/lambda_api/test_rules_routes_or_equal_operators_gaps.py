"""WHIT-561 follow-up GAP tests — the new amount operators END-TO-END through the API validator.

The engine now evaluates less_than_or_equal / greater_than_or_equal, and RULE_FIELD_OPERATORS was
widened in lockstep. This proves the HTTP layer actually accepts them now (a body that was 400
before the widening) and still rejects a bogus amount operator. Driven through lambda_handler with
the real RuleRepository over a FakeTable, exactly like test_rules_routes_multi_condition.py."""

import json
from functools import partial

from _api_event import api_event
from _feed_fakes import Repos, inject_rule_routes


_CATEGORIES = ("transport", "groceries")


_inject = partial(inject_rule_routes, categories=_CATEGORIES)


def _body(operator, category_id="transport"):
    return {"conditions": [{"field": "amount", "operator": operator, "value": "30"}],
            "logic": "all", "categoryId": category_id}


def test_post_rule_with_less_than_or_equal_is_accepted(handler, monkeypatch):
    # [A10] Previously 400 (not in the vocab); now the validator accepts it -> 201 and it is stored.
    repo = Repos()
    _inject(handler, monkeypatch, repo)
    resp = handler.lambda_handler(api_event("POST", "/rules", _body("less_than_or_equal")), None)
    assert resp["statusCode"] == 201, resp["body"]
    out = json.loads(resp["body"])
    assert out["conditions"][0]["operator"] == "less_than_or_equal"
    assert repo.minted_rules()[0]["conditions"][0]["operator"] == "less_than_or_equal"


def test_post_rule_with_greater_than_or_equal_is_accepted(handler, monkeypatch):
    # [A11] Same for >=.
    repo = Repos()
    _inject(handler, monkeypatch, repo)
    resp = handler.lambda_handler(api_event("POST", "/rules", _body("greater_than_or_equal")), None)
    assert resp["statusCode"] == 201, resp["body"]
    assert json.loads(resp["body"])["conditions"][0]["operator"] == "greater_than_or_equal"


def test_post_rule_with_a_bogus_amount_operator_is_still_400(handler, monkeypatch):
    # [A12] The widening must not open the gate to arbitrary operators: an unknown amount operator
    # the engine can't evaluate is still rejected (guards an over-broad frozenset edit).
    repo = Repos()
    _inject(handler, monkeypatch, repo)
    resp = handler.lambda_handler(api_event("POST", "/rules", _body("at_most")), None)
    assert resp["statusCode"] == 400
    assert repo.minted_rules() == []


def test_put_rule_can_move_a_condition_to_a_new_or_equal_operator(handler, monkeypatch):
    # [A13] The new operators also validate on the UPDATE path, not just create. Seed a rule, then
    # PUT it with less_than_or_equal and expect a 2xx (not the pre-widening 400).
    seed = {"field": "amount", "operator": "less_than", "value": "30",
            "category_id": "transport", "conditions":
                [{"field": "amount", "operator": "less_than", "value": "30"}], "logic": "all"}
    repo = Repos(rules=[seed])
    rule_id = repo.rule_repo.list_rules()[0]["id"]
    _inject(handler, monkeypatch, repo)
    resp = handler.lambda_handler(
        api_event("PUT", f"/rules/{rule_id}",
               {"conditions": [{"field": "amount", "operator": "less_than_or_equal", "value": "30"}],
                "logic": "all", "categoryId": "transport"},
               path_params={"id": rule_id}), None)
    assert resp["statusCode"] in (200, 201), resp["body"]
    assert json.loads(resp["body"])["conditions"][0]["operator"] == "less_than_or_equal"
