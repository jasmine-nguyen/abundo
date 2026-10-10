"""HTTP-layer tests for GET/POST /rules and PUT/DELETE /rules/{id} (WHIT-529).

These routes back the app's Rules screen with our OWN store (RuleRepository). Everything is
driven through lambda_handler with the real RuleRepository (over a FakeTable) injected as
handler.RuleRepository, so the dispatch, the store->client mapping (rule_book.rule_from_row), and
the write guards this route adds (vocabulary, value floor, category check) are all exercised
end to end.
"""

import json
from functools import partial

import pytest

from _api_event import api_event
from _feed_fakes import Repos, _rule, inject_rule_routes
from _rule_pairs import PAIR_VALUE, RULE_PAIRS


_CATEGORIES = ("groceries", "petrol", "transport")

_CLIENT_KEYS = {"id", "field", "operator", "value", "categoryId", "budgetExcluded",
                "spread", "spreadAmount", "spreadGapDays", "conditions", "logic"}


def _flat(value, field="description", operator="contains", category_id="groceries"):
    return {"field": field, "operator": operator, "value": value, "categoryId": category_id}


def _multi(conditions, logic="all", category_id="transport"):
    return {"conditions": conditions, "logic": logic, "categoryId": category_id}


def _amount(value, operator="less_than"):
    return {"field": "amount", "operator": operator, "value": value}


def _text(value, field="description", operator="contains"):
    return {"field": field, "operator": operator, "value": value}


def _post(handler, body):
    return handler.lambda_handler(api_event("POST", "/rules", body), None)


def _put(handler, rule_id, body):
    return handler.lambda_handler(
        api_event("PUT", f"/rules/{rule_id}", body, path_params={"id": rule_id}), None)


def _shown_value(rule):
    """The value the app shows: a flat rule's own value, else its first condition's."""
    if rule["conditions"]:
        return rule["conditions"][0]["value"]
    return rule["value"]


_inject = partial(inject_rule_routes, categories=_CATEGORIES)


# --- GET /rules ---------------------------------------------------------------


def test_get_rules_returns_a_bare_client_shaped_array(handler, monkeypatch):
    repo = Repos(rules=[_rule("COLES", "groceries"), _rule("BP 2210", "petrol")])
    _inject(handler, monkeypatch, repo)

    resp = handler.lambda_handler(api_event("GET", "/rules"), None)
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 200
    assert isinstance(body, list) and len(body) == 2
    by_value = {rule["value"]: rule for rule in body}
    # Client shape: category_id -> categoryId.
    assert by_value["COLES"]["categoryId"] == "groceries"
    assert by_value["BP 2210"]["categoryId"] == "petrol"
    assert set(by_value["COLES"]) == _CLIENT_KEYS


def test_get_rules_reads_a_legacy_row_into_the_clean_shape(handler, monkeypatch):
    # A row written before WHIT-558 / WHIT-535 has no budget_excluded key and still carries the
    # retired import fields. GET must read it without error (no data migration), default the flag
    # to False and drop the retired keys from the client shape.
    legacy = {"pk": "RULE", "sk": "RULE#r-legacy", "id": "r-legacy",
              "field": "description", "operator": "contains",
              "value": "COLES", "category_id": "groceries", "source": "banksync",
              "imported_at": "2026-07-02T00:00:00+00:00",
              "banksync_enrichment_ids": ["enr_1", "enr_2"], "conditionCount": 1}
    repo = Repos()
    repo.table.seed(legacy)
    _inject(handler, monkeypatch, repo)

    resp = handler.lambda_handler(api_event("GET", "/rules"), None)
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 200
    assert len(body) == 1
    assert set(body[0]) == _CLIENT_KEYS
    assert body[0]["value"] == "COLES" and body[0]["categoryId"] == "groceries"
    assert body[0]["budgetExcluded"] is False


# --- POST /rules --------------------------------------------------------------


def test_create_rule_happy_path_trims_defaults_and_returns_201(handler, monkeypatch):
    repo = Repos()
    _inject(handler, monkeypatch, repo)

    resp = _post(handler, {"value": "  cOlEs  Online  ", "categoryId": " groceries "})
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 201
    assert body["value"] == "cOlEs  Online"        # ends trimmed, inner spacing + case kept
    assert body["categoryId"] == "groceries"       # trimmed
    assert body["field"] == "description" and body["operator"] == "contains"   # defaulted
    # Actually written, with the normalised fields.
    assert len(repo.minted_rules()) == 1
    assert repo.minted_rules()[0]["value"] == "cOlEs  Online"
    assert repo.minted_rules()[0]["category_id"] == "groceries"


def test_create_rule_same_text_same_category_returns_201_without_writing(handler, monkeypatch):
    repo = Repos(rules=[_rule("COLES", "groceries")])
    _inject(handler, monkeypatch, repo)

    resp = _post(handler, {"value": "COLES", "categoryId": "groceries"})
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 201                # parity: dedup hit is still 201
    assert body["categoryId"] == "groceries"
    assert repo.minted_rules() == []                        # nothing newly written
    assert len(repo.rule_repo.list_rules()) == 1


def test_create_rule_same_text_different_category_is_a_409_with_the_existing_rule(handler,
                                                                                 monkeypatch):
    repo = Repos(rules=[_rule("COLES", "groceries")])
    _inject(handler, monkeypatch, repo)

    resp = _post(handler, {"value": "COLES", "categoryId": "petrol"})
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 409
    assert body["existingRule"]["categoryId"] == "groceries"   # the winner, not petrol
    assert "existingRule" in body and body["existingRule"]["value"] == "COLES"
    assert len(repo.rule_repo.list_rules()) == 1              # the clashing write left nothing behind


def test_create_rule_same_text_same_category_different_flag_is_a_409(handler, monkeypatch):
    # The 409 body carries the EXISTING rule's flag (False), not the attempted True.
    repo = Repos(rules=[_rule("COLES", "groceries", budget_excluded=False)])
    _inject(handler, monkeypatch, repo)

    resp = _post(handler, {"value": "COLES", "categoryId": "groceries", "budgetExcluded": True})
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 409
    assert body["existingRule"]["value"] == "COLES"
    assert body["existingRule"]["budgetExcluded"] is False
    assert len(repo.rule_repo.list_rules()) == 1


def test_budget_excluded_round_trips_on_create_and_toggles_on_update(handler, monkeypatch):
    repo = Repos()
    _inject(handler, monkeypatch, repo)

    created = _post(handler, {"value": "SPLITWISE", "categoryId": "groceries",
                              "budgetExcluded": True})
    created_body = json.loads(created["body"])
    assert created["statusCode"] == 201
    assert created_body["budgetExcluded"] is True
    rule_id = created_body["id"]
    assert repo.rule_repo.get_rule(rule_id)["budget_excluded"] is True

    updated = _put(handler, rule_id, {"value": "SPLITWISE", "categoryId": "groceries",
                                      "budgetExcluded": False})
    assert updated["statusCode"] == 200
    assert json.loads(updated["body"])["budgetExcluded"] is False
    assert repo.rule_repo.get_rule(rule_id)["budget_excluded"] is False


def test_create_rule_unknown_category_is_400(handler, monkeypatch):
    repo = Repos()
    _inject(handler, monkeypatch, repo)

    resp = _post(handler, {"value": "WOOLWORTHS", "categoryId": "not-a-category"})

    assert resp["statusCode"] == 400
    assert "categoryId" in json.loads(resp["body"])["error"]
    assert repo.minted_rules() == []                        # rejected before any write


@pytest.mark.parametrize("body, expected", [
    (_flat("."), 400),
    (_flat("a-b-c"), 400),          # 3 letters/digits (hyphens don't count) -> below the floor of 4
    (_flat("a-b-cd"), 201),         # exactly at the floor
    (_flat("AB", field="category", operator="equals"), 201),   # exact match, not floored
    (_multi([_text("."), _amount("30")]), 400),
    (_multi([_text(".", field="merchant"), _amount("30")]), 400),
    (_multi([_text("a1", field="account", operator="equals"), _amount(1)]), 201),
])
def test_value_floor_applies_only_to_contains_conditions(handler, monkeypatch, body, expected):
    # A near-empty substring value would match nearly every charge, so `contains` values need at
    # least 4 letters/digits. Exact-match fields (category, account, amount) are not floored.
    repo = Repos()
    _inject(handler, monkeypatch, repo)

    resp = _post(handler, body)

    assert resp["statusCode"] == expected
    if expected == 400:
        assert "letters or digits" in json.loads(resp["body"])["error"]
        assert repo.minted_rules() == []


@pytest.mark.parametrize("body, missing", [
    ({"categoryId": "groceries"}, "value"),
    ({"value": "  ", "categoryId": "groceries"}, "value"),
    ({"value": "WOOLWORTHS"}, "categoryId"),
    ({"value": "WOOLWORTHS", "categoryId": "  "}, "categoryId"),
])
def test_create_rule_missing_fields_400(handler, monkeypatch, body, missing):
    _inject(handler, monkeypatch, Repos())
    resp = _post(handler, body)
    assert resp["statusCode"] == 400
    assert missing in json.loads(resp["body"])["error"]


@pytest.mark.parametrize("body", [
    _flat("abc", field="amount", operator="less_than"),           # flat amount validates too
    _flat("0", field="amount", operator="less_than"),
    _flat("30", field="amount", operator="contains"),             # flat pair outside the vocab
    _multi([_amount("30", operator="contains")]),                 # pair outside the vocab
    _multi([_text("debit", field="direction", operator="equals")]),
    _multi([_text("X", field="payee", operator="equals")]),       # unknown field
    _multi([_text("UBER", field="merchant")], logic="xor"),
    _multi([_amount("lots")]),
    _multi([_amount("0")]),
    _multi([_amount(True)]),                                      # a JSON bool is not an amount
    _flat("NETFLIX") | {"spread": "yes"},                         # spread must be a real bool
    _multi([_text("sideways", field="direction", operator="is")]),
    _multi([]),
    _multi([_text(42, field="merchant")]),                        # text value must be a string
    _multi(["merchant contains uber"]),                           # condition must be an object
])
def test_create_rule_rejects_an_invalid_body_400(handler, monkeypatch, body):
    repo = Repos()
    _inject(handler, monkeypatch, repo)
    resp = _post(handler, body)
    assert resp["statusCode"] == 400
    assert repo.minted_rules() == []


@pytest.mark.parametrize("field, operator, logic", [
    *[(field, operator, "all") for field, operator in RULE_PAIRS],
    ("merchant", "contains", "any"),
])
def test_every_supported_pair_is_accepted(handler, monkeypatch, field, operator, logic):
    _inject(handler, monkeypatch, Repos())
    condition = {"field": field, "operator": operator, "value": PAIR_VALUE.get(field, "UBER")}
    resp = _post(handler, _multi([condition], logic=logic))
    assert resp["statusCode"] == 201, resp["body"]


def test_create_multi_condition_rule_round_trips_with_default_logic_all(handler, monkeypatch):
    repo = Repos()
    _inject(handler, monkeypatch, repo)
    body = {"conditions": [_text("UBER", field="merchant"), _amount("30")],
            "categoryId": "transport"}

    resp = _post(handler, body)
    out = json.loads(resp["body"])

    assert resp["statusCode"] == 201
    assert out["logic"] == "all"
    assert [c["field"] for c in out["conditions"]] == ["merchant", "amount"]
    assert out["conditions"][0]["value"] == "UBER"
    assert out["conditions"][1]["value"] == "30"
    assert repo.minted_rules()[0]["conditions"][1]["field"] == "amount"


@pytest.mark.parametrize("bodies, rule_count, shown", [
    ([_multi([_amount(s)]) for s in ("30", "30.0", "30.00", "30.000")], 1, "30"),
    ([_multi([_amount("1e3")]), _multi([_amount("1000")])], 1, "1000"),       # never "1E+3"
    ([_multi([_amount(30)]), _multi([_amount("30.00")])], 1, "30"),           # JSON number
    ([_flat("30.00", field="amount", operator="less_than"),
      _flat("30", field="amount", operator="less_than")], 1, "30"),
    ([_flat("30.00", field="amount", operator="less_than", category_id="transport"),
      _multi([_amount("30.00")])], 1, "30"),                                 # flat == one-condition multi
    ([_multi([_amount("0.10")]), _multi([_amount("0.1")])], 1, "0.1"),
    ([_multi([_amount("30.00")]), _multi([_amount("30.5")])], 2, "30"),      # a different amount
    ([_multi([_amount("0.05")]), _multi([_amount("0.5")])], 2, "0.05"),
])
def test_equivalent_spellings_share_one_rule(handler, monkeypatch, bodies, rule_count, shown):
    # The value is normalised before it becomes the stored value and the rule id, so equivalent
    # spellings land on one row instead of minting duplicates.
    repo = Repos()
    _inject(handler, monkeypatch, repo)

    replies = [_post(handler, body) for body in bodies]

    assert [reply["statusCode"] for reply in replies] == [201] * len(bodies)
    outs = [json.loads(reply["body"]) for reply in replies]
    assert len({out["id"] for out in outs}) == rule_count
    assert len(repo.minted_rules()) == rule_count
    assert _shown_value(outs[0]) == shown


def test_a_case_and_spacing_variant_dedups_onto_the_existing_rule(handler, monkeypatch):
    repo = Repos(rules=[_rule("COLES  EXPRESS", "groceries")])
    _inject(handler, monkeypatch, repo)

    resp = _post(handler, {"value": "coles express", "categoryId": "groceries"})

    assert resp["statusCode"] == 201
    assert repo.minted_rules() == []


# --- PUT /rules/{id} ----------------------------------------------------------


@pytest.mark.parametrize("seed, body, shown, category_id", [
    (_rule("COLES"), {"value": "COLES", "categoryId": "petrol"}, "COLES", "petrol"),
    (_rule("COLES"), {"value": "coles", "categoryId": "groceries"}, "coles", "groceries"),
    (_rule("30", "transport", field="amount", operator="less_than"),
     _flat("30.00", field="amount", operator="less_than", category_id="transport"),
     "30", "transport"),
])
def test_an_in_place_edit_keeps_the_id(handler, monkeypatch, seed, body, shown, category_id):
    # The id is the DB key and filed charges carry it, so an edit that folds to the same id must
    # update in place — never move the row and orphan the charges it filed.
    repo = Repos(rules=[seed])
    rule_id = repo.rule_repo.list_rules()[0]["id"]
    _inject(handler, monkeypatch, repo)

    resp = _put(handler, rule_id, body)
    out = json.loads(resp["body"])

    assert resp["statusCode"] == 200
    assert out["id"] == rule_id
    assert out["value"] == shown
    assert out["categoryId"] == category_id
    assert [r["id"] for r in repo.rule_repo.list_rules()] == [rule_id]


def test_update_rule_text_edit_returns_a_new_id_and_removes_the_old(handler, monkeypatch):
    repo = Repos(rules=[_rule("COLES", "groceries")])
    old_id = repo.rule_repo.list_rules()[0]["id"]
    _inject(handler, monkeypatch, repo)

    resp = _put(handler, old_id, {"value": "COLES EXPRESS", "categoryId": "groceries"})
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 200
    assert body["id"] != old_id                     # id follows the text
    assert body["value"] == "COLES EXPRESS"
    assert {r["id"] for r in repo.rule_repo.list_rules()} == {body["id"]}    # old id gone, one row


def test_update_rule_onto_another_rules_text_is_a_409(handler, monkeypatch):
    repo = Repos(rules=[_rule("COLES", "groceries"), _rule("WOOLWORTHS", "groceries")])
    coles_id = repo.rule_id("COLES")
    _inject(handler, monkeypatch, repo)

    resp = _put(handler, coles_id, {"value": "WOOLWORTHS", "categoryId": "groceries"})
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 409
    assert body["existingRule"]["value"] == "WOOLWORTHS"
    assert len(repo.rule_repo.list_rules()) == 2              # both rows intact


def test_update_rule_unknown_id_is_404(handler, monkeypatch):
    _inject(handler, monkeypatch, Repos())
    resp = _put(handler, "deadbeef", {"value": "WOOLWORTHS", "categoryId": "groceries"})
    assert resp["statusCode"] == 404


@pytest.mark.parametrize("body", [
    {"value": ".", "categoryId": "groceries"},                    # under the value floor
    {"value": "COLES", "categoryId": "not-a-category"},
])
def test_update_rule_rejects_an_invalid_body_400(handler, monkeypatch, body):
    repo = Repos(rules=[_rule("COLES", "groceries")])
    rule_id = repo.rule_id("COLES")
    _inject(handler, monkeypatch, repo)
    before = repo.stored_rules()

    resp = _put(handler, rule_id, body)

    assert resp["statusCode"] == 400
    assert repo.stored_rules() == before


# --- DELETE /rules/{id} -------------------------------------------------------


def _delete(handler, rule_id):
    return handler.lambda_handler(
        api_event("DELETE", f"/rules/{rule_id}", path_params={"id": rule_id}), None)


def test_delete_rule_removes_it_and_returns_200(handler, monkeypatch):
    repo = Repos(rules=[_rule("COLES", "groceries")])
    rule_id = repo.rule_repo.list_rules()[0]["id"]
    _inject(handler, monkeypatch, repo)

    resp = _delete(handler, rule_id)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"id": rule_id, "remaining": 0}
    assert repo.rule_repo.list_rules() == []


def test_delete_rule_is_idempotent(handler, monkeypatch):
    # A second delete of the same (now-gone) id must still be 200 — a double-tap can't error.
    repo = Repos(rules=[_rule("COLES", "groceries")])
    rule_id = repo.rule_repo.list_rules()[0]["id"]
    _inject(handler, monkeypatch, repo)

    first = _delete(handler, rule_id)
    second = _delete(handler, rule_id)

    assert first["statusCode"] == 200 and second["statusCode"] == 200


# --- store faults map to a clean 500 (not an uncaught 502) --------------------


def _get_rules(handler, rule_id):
    return handler.lambda_handler(api_event("GET", "/rules"), None)


def _create_rule(handler, rule_id):
    return _post(handler, {"value": "WOOLWORTHS", "categoryId": "groceries"})


def _update_rule(handler, rule_id):
    return _put(handler, rule_id, {"value": "COLES", "categoryId": "petrol"})


@pytest.mark.parametrize("failing_call, send", [
    ("query", _get_rules),
    ("put_item", _create_rule),
    ("update_item", _update_rule),
    ("delete_item", _delete),
])
def test_a_store_fault_is_a_clean_500(handler, monkeypatch, failing_call, send):
    repo = Repos(rules=[_rule("COLES", "groceries")])
    rule_id = repo.rule_repo.list_rules()[0]["id"]
    repo.table.fail(failing_call)
    _inject(handler, monkeypatch, repo)

    resp = send(handler, rule_id)

    assert resp["statusCode"] == 500
    assert "error" in json.loads(resp["body"])
