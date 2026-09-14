"""HTTP-layer tests for GET/POST /rules and PUT/DELETE /rules/{id} (WHIT-529).

These routes back the app's Rules screen with our OWN store (RuleRepository). Everything is
driven through lambda_handler with a FakeRuleRepo injected as handler.RuleRepository, so the
dispatch, the store->client mapping (_rule_to_client), and the two write guards this route adds
(the value floor and the category check) are all exercised end to end.

The fake-vs-real faithfulness of FakeRuleRepo lives in tests/shared/test_rule_fake_contract_gaps.py;
this suite does not re-check it.
"""

import base64
import json

import pytest

from _feed_fakes import FakeCategoryRepo
from _rule_fakes import FakeRuleRepo


_CATEGORIES = ("groceries", "petrol")


def _rule(value, category_id="groceries", field="description", operator="contains"):
    """A stored rule row (snake_case, no id) — FakeRuleRepo derives the id the store's way."""
    return {"field": field, "operator": operator, "value": value, "category_id": category_id}


def _event(method, path, body=None, path_params=None, base64_body=False):
    event = {"rawPath": path, "requestContext": {"http": {"method": method}}}
    if body is not None:
        if base64_body:
            event["body"] = base64.b64encode(json.dumps(body).encode()).decode()
            event["isBase64Encoded"] = True
        else:
            event["body"] = json.dumps(body)
    if path_params is not None:
        event["pathParameters"] = path_params
    return event


def _inject(handler, monkeypatch, rule_repo, categories=_CATEGORIES):
    monkeypatch.setattr(handler, "RuleRepository", lambda: rule_repo)
    monkeypatch.setattr(handler, "CategoryRepository", lambda: FakeCategoryRepo(categories))


# --- GET /rules ---------------------------------------------------------------


def test_get_rules_returns_a_bare_client_shaped_array(handler, monkeypatch):
    repo = FakeRuleRepo(rules=[_rule("COLES", "groceries"), _rule("BP 2210", "petrol")])
    _inject(handler, monkeypatch, repo)

    resp = handler.lambda_handler(_event("GET", "/rules"), None)
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 200
    assert isinstance(body, list) and len(body) == 2
    by_value = {rule["value"]: rule for rule in body}
    # Client shape: category_id -> categoryId.
    assert by_value["COLES"]["categoryId"] == "groceries"
    assert by_value["BP 2210"]["categoryId"] == "petrol"
    assert set(by_value["COLES"]) == {"id", "field", "operator", "value", "categoryId"}


def test_get_rules_empty_store_is_an_empty_array(handler, monkeypatch):
    _inject(handler, monkeypatch, FakeRuleRepo())
    resp = handler.lambda_handler(_event("GET", "/rules"), None)
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == []


def test_get_on_a_rule_item_path_is_not_routed(handler, monkeypatch):
    # There is no GET /rules/{id}; it must fall through to the gateway 404, not list.
    _inject(handler, monkeypatch, FakeRuleRepo(rules=[_rule("COLES")]))
    resp = handler.lambda_handler(_event("GET", "/rules/whatever"), None)
    assert resp["statusCode"] == 404


# --- POST /rules --------------------------------------------------------------


def test_create_rule_happy_path_trims_defaults_and_returns_201(handler, monkeypatch):
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)

    resp = handler.lambda_handler(
        _event("POST", "/rules", {"value": " WOOLWORTHS ", "categoryId": " groceries "}), None)
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 201
    assert body["value"] == "WOOLWORTHS"           # trimmed
    assert body["categoryId"] == "groceries"       # trimmed
    assert body["field"] == "description" and body["operator"] == "contains"   # defaulted
    # Actually written, with the normalised fields.
    assert len(repo.minted) == 1
    assert repo.minted[0]["value"] == "WOOLWORTHS"
    assert repo.minted[0]["category_id"] == "groceries"


def test_create_rule_accepts_the_verified_category_equals_vocab(handler, monkeypatch):
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)

    resp = handler.lambda_handler(
        _event("POST", "/rules", {"value": "FOOD_AND_DRINK", "categoryId": "groceries",
                                  "field": "category", "operator": "equals"}), None)

    assert resp["statusCode"] == 201
    assert repo.minted[0]["field"] == "category" and repo.minted[0]["operator"] == "equals"


def test_create_rule_same_text_same_category_returns_201_without_writing(handler, monkeypatch):
    repo = FakeRuleRepo(rules=[_rule("COLES", "groceries")])
    _inject(handler, monkeypatch, repo)

    resp = handler.lambda_handler(
        _event("POST", "/rules", {"value": "COLES", "categoryId": "groceries"}), None)
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 201                # parity: dedup hit is still 201
    assert body["categoryId"] == "groceries"
    assert repo.minted == []                        # nothing newly written
    assert len(repo.list_rules()) == 1


def test_create_rule_same_text_different_category_is_a_409_with_the_existing_rule(handler,
                                                                                 monkeypatch):
    repo = FakeRuleRepo(rules=[_rule("COLES", "groceries")])
    _inject(handler, monkeypatch, repo)

    resp = handler.lambda_handler(
        _event("POST", "/rules", {"value": "COLES", "categoryId": "petrol"}), None)
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 409
    assert body["existingRule"]["categoryId"] == "groceries"   # the winner, not petrol
    assert "existingRule" in body and body["existingRule"]["value"] == "COLES"
    assert len(repo.list_rules()) == 1              # the clashing write left nothing behind


def test_create_rule_unknown_category_is_400(handler, monkeypatch):
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)

    resp = handler.lambda_handler(
        _event("POST", "/rules", {"value": "WOOLWORTHS", "categoryId": "not-a-category"}), None)

    assert resp["statusCode"] == 400
    assert "categoryId" in json.loads(resp["body"])["error"]
    assert repo.minted == []                        # rejected before any write


def test_create_rule_value_below_the_floor_is_400_for_description_contains(handler, monkeypatch):
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)

    resp = handler.lambda_handler(
        _event("POST", "/rules", {"value": ".", "categoryId": "groceries"}), None)

    assert resp["statusCode"] == 400
    assert "letters or digits" in json.loads(resp["body"])["error"]
    assert repo.minted == []


def test_the_value_floor_does_not_apply_to_category_equals(handler, monkeypatch):
    # A category-equals rule matches EXACTLY, not by substring, so the anti-over-match floor is
    # gated to description/contains — a short category value is accepted.
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)

    resp = handler.lambda_handler(
        _event("POST", "/rules", {"value": "AB", "categoryId": "groceries",
                                  "field": "category", "operator": "equals"}), None)

    assert resp["statusCode"] == 201
    assert repo.minted[0]["value"] == "AB"


@pytest.mark.parametrize("body, missing", [
    ({"categoryId": "groceries"}, "value"),
    ({"value": "  ", "categoryId": "groceries"}, "value"),
    ({"value": "WOOLWORTHS"}, "categoryId"),
    ({"value": "WOOLWORTHS", "categoryId": "  "}, "categoryId"),
])
def test_create_rule_missing_fields_400(handler, monkeypatch, body, missing):
    _inject(handler, monkeypatch, FakeRuleRepo())
    resp = handler.lambda_handler(_event("POST", "/rules", body), None)
    assert resp["statusCode"] == 400
    assert missing in json.loads(resp["body"])["error"]


@pytest.mark.parametrize("bad", [
    {"value": "WOOLWORTHS", "categoryId": "groceries", "field": "amount"},
    {"value": "WOOLWORTHS", "categoryId": "groceries", "operator": "startsWith"},
])
def test_create_rule_rejects_unverified_vocab_400(handler, monkeypatch, bad):
    _inject(handler, monkeypatch, FakeRuleRepo())
    resp = handler.lambda_handler(_event("POST", "/rules", bad), None)
    assert resp["statusCode"] == 400


def test_create_rule_invalid_json_is_400(handler, monkeypatch):
    _inject(handler, monkeypatch, FakeRuleRepo())
    event = {"rawPath": "/rules", "requestContext": {"http": {"method": "POST"}}, "body": "{bad"}
    resp = handler.lambda_handler(event, None)
    assert resp["statusCode"] == 400


def test_create_rule_accepts_a_base64_encoded_body(handler, monkeypatch):
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)

    resp = handler.lambda_handler(
        _event("POST", "/rules", {"value": "WOOLWORTHS", "categoryId": "groceries"},
               base64_body=True), None)

    assert resp["statusCode"] == 201
    assert repo.minted[0]["value"] == "WOOLWORTHS"


# --- PUT /rules/{id} ----------------------------------------------------------


def test_update_rule_category_change_keeps_the_id(handler, monkeypatch):
    repo = FakeRuleRepo(rules=[_rule("COLES", "groceries")])
    rule_id = repo.list_rules()[0]["id"]
    _inject(handler, monkeypatch, repo)

    resp = handler.lambda_handler(
        _event("PUT", f"/rules/{rule_id}", {"value": "COLES", "categoryId": "petrol"},
               path_params={"id": rule_id}), None)
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 200
    assert body["id"] == rule_id                    # unchanged
    assert body["categoryId"] == "petrol"


def test_update_rule_text_edit_returns_a_new_id_and_removes_the_old(handler, monkeypatch):
    repo = FakeRuleRepo(rules=[_rule("COLES", "groceries")])
    old_id = repo.list_rules()[0]["id"]
    _inject(handler, monkeypatch, repo)

    resp = handler.lambda_handler(
        _event("PUT", f"/rules/{old_id}", {"value": "COLES EXPRESS", "categoryId": "groceries"},
               path_params={"id": old_id}), None)
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 200
    assert body["id"] != old_id                     # id follows the text
    assert body["value"] == "COLES EXPRESS"
    assert {r["id"] for r in repo.list_rules()} == {body["id"]}    # old id gone, one row


def test_update_rule_onto_another_rules_text_is_a_409(handler, monkeypatch):
    repo = FakeRuleRepo(rules=[_rule("COLES", "groceries"), _rule("WOOLWORTHS", "groceries")])
    coles_id = next(r["id"] for r in repo.list_rules() if r["value"] == "COLES")
    _inject(handler, monkeypatch, repo)

    resp = handler.lambda_handler(
        _event("PUT", f"/rules/{coles_id}", {"value": "WOOLWORTHS", "categoryId": "groceries"},
               path_params={"id": coles_id}), None)
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 409
    assert body["existingRule"]["value"] == "WOOLWORTHS"
    assert len(repo.list_rules()) == 2              # both rows intact


def test_update_rule_unknown_id_is_404(handler, monkeypatch):
    _inject(handler, monkeypatch, FakeRuleRepo())
    resp = handler.lambda_handler(
        _event("PUT", "/rules/deadbeef", {"value": "WOOLWORTHS", "categoryId": "groceries"},
               path_params={"id": "deadbeef"}), None)
    assert resp["statusCode"] == 404


def test_update_rule_missing_path_id_is_404(handler, monkeypatch):
    _inject(handler, monkeypatch, FakeRuleRepo())
    resp = handler.lambda_handler(
        _event("PUT", "/rules/", {"value": "WOOLWORTHS", "categoryId": "groceries"}), None)
    assert resp["statusCode"] == 404


def test_update_rule_missing_value_is_400(handler, monkeypatch):
    repo = FakeRuleRepo(rules=[_rule("COLES", "groceries")])
    rule_id = repo.list_rules()[0]["id"]
    _inject(handler, monkeypatch, repo)
    resp = handler.lambda_handler(
        _event("PUT", f"/rules/{rule_id}", {"categoryId": "groceries"},
               path_params={"id": rule_id}), None)
    assert resp["statusCode"] == 400


def test_update_rule_unknown_category_is_400(handler, monkeypatch):
    repo = FakeRuleRepo(rules=[_rule("COLES", "groceries")])
    rule_id = repo.list_rules()[0]["id"]
    _inject(handler, monkeypatch, repo)
    resp = handler.lambda_handler(
        _event("PUT", f"/rules/{rule_id}", {"value": "COLES", "categoryId": "not-a-category"},
               path_params={"id": rule_id}), None)
    assert resp["statusCode"] == 400
    assert "categoryId" in json.loads(resp["body"])["error"]


def test_update_rule_bad_body_beats_unknown_id_with_a_400(handler, monkeypatch):
    # An unknown id AND a missing value: body validation runs before the store lookup, so the
    # client gets the more specific 400, not a 404. Pins the check order.
    _inject(handler, monkeypatch, FakeRuleRepo())
    resp = handler.lambda_handler(
        _event("PUT", "/rules/deadbeef", {"categoryId": "groceries"},
               path_params={"id": "deadbeef"}), None)
    assert resp["statusCode"] == 400


# --- DELETE /rules/{id} -------------------------------------------------------


def test_delete_rule_removes_it_and_returns_200(handler, monkeypatch):
    repo = FakeRuleRepo(rules=[_rule("COLES", "groceries")])
    rule_id = repo.list_rules()[0]["id"]
    _inject(handler, monkeypatch, repo)

    resp = handler.lambda_handler(
        _event("DELETE", f"/rules/{rule_id}", path_params={"id": rule_id}), None)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"id": rule_id}
    assert repo.list_rules() == []


def test_delete_rule_is_idempotent(handler, monkeypatch):
    # A second delete of the same (now-gone) id must still be 200 — a double-tap can't error.
    repo = FakeRuleRepo(rules=[_rule("COLES", "groceries")])
    rule_id = repo.list_rules()[0]["id"]
    _inject(handler, monkeypatch, repo)

    first = handler.lambda_handler(
        _event("DELETE", f"/rules/{rule_id}", path_params={"id": rule_id}), None)
    second = handler.lambda_handler(
        _event("DELETE", f"/rules/{rule_id}", path_params={"id": rule_id}), None)

    assert first["statusCode"] == 200 and second["statusCode"] == 200


def test_delete_rule_unknown_id_is_200(handler, monkeypatch):
    _inject(handler, monkeypatch, FakeRuleRepo())
    resp = handler.lambda_handler(
        _event("DELETE", "/rules/deadbeef", path_params={"id": "deadbeef"}), None)
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"id": "deadbeef"}


def test_delete_rule_missing_path_id_is_404(handler, monkeypatch):
    _inject(handler, monkeypatch, FakeRuleRepo())
    resp = handler.lambda_handler(_event("DELETE", "/rules/"), None)
    assert resp["statusCode"] == 404


# --- store faults map to a clean 500 (not an uncaught 502) --------------------


def test_get_rules_store_fault_is_a_clean_500(handler, monkeypatch):
    _inject(handler, monkeypatch, FakeRuleRepo(list_error=True))
    resp = handler.lambda_handler(_event("GET", "/rules"), None)
    assert resp["statusCode"] == 500
    assert "rules" in json.loads(resp["body"])["error"]


def test_create_rule_store_fault_is_a_clean_500(handler, monkeypatch):
    _inject(handler, monkeypatch, FakeRuleRepo(create_error=True))
    resp = handler.lambda_handler(
        _event("POST", "/rules", {"value": "WOOLWORTHS", "categoryId": "groceries"}), None)
    assert resp["statusCode"] == 500


def test_update_rule_store_fault_is_a_clean_500(handler, monkeypatch):
    repo = FakeRuleRepo(rules=[_rule("COLES", "groceries")], update_error=True)
    rule_id = repo.list_rules()[0]["id"]
    _inject(handler, monkeypatch, repo)
    resp = handler.lambda_handler(
        _event("PUT", f"/rules/{rule_id}", {"value": "COLES", "categoryId": "petrol"},
               path_params={"id": rule_id}), None)
    assert resp["statusCode"] == 500


def test_delete_rule_store_fault_is_a_clean_500(handler, monkeypatch):
    repo = FakeRuleRepo(rules=[_rule("COLES", "groceries")], delete_error=True)
    rule_id = repo.list_rules()[0]["id"]
    _inject(handler, monkeypatch, repo)
    resp = handler.lambda_handler(
        _event("DELETE", f"/rules/{rule_id}", path_params={"id": rule_id}), None)
    assert resp["statusCode"] == 500


# --- terraform route registration for the item routes -------------------------


def test_item_routes_are_declared_in_api_gateway():
    # test_route_registration.py covers the exact GET/POST routes automatically, but the
    # startswith-dispatched {id} routes carry a placeholder it can't derive — pin them by hand so
    # a PUT/DELETE that works in tests can't 404 at the deployed gateway (WHIT-506's failure mode).
    import pathlib

    apigateway = (pathlib.Path(__file__).resolve().parents[2]
                  / "terraform" / "apigateway.tf").read_text()
    assert '"PUT /rules/{id}"' in apigateway
    assert '"DELETE /rules/{id}"' in apigateway
