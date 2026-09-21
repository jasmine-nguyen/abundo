"""Adversarial gap coverage for GET/POST /rules and PUT/DELETE /rules/{id} (WHIT-529).

Sibling to test_rules_routes.py (the implementer's happy-path + acceptance suite). This file adds
the edges that suite does not lock: the store->client mapper / fold round-trip, non-ASCII values,
the value-floor boundary + its enforcement on PUT, a rule whose category was later deleted, guard
precedence, and the VersionConflictError->409 dispatch wiring. Nothing here re-checks a case
test_rules_routes.py already covers.

Same doubles/harness as the sibling: lambda_handler with FakeRuleRepo injected as
handler.RuleRepository and FakeCategoryRepo as handler.CategoryRepository.
"""

import json

import pytest

from _feed_fakes import FakeCategoryRepo, WritableFeedRepo
from _rule_fakes import FakeRuleRepo


_CATEGORIES = ("groceries", "petrol")


def _rule(value, category_id="groceries", field="description", operator="contains"):
    return {"field": field, "operator": operator, "value": value, "category_id": category_id}


def _event(method, path, body=None, path_params=None):
    event = {"rawPath": path, "requestContext": {"http": {"method": method}}}
    if body is not None:
        event["body"] = json.dumps(body)
    if path_params is not None:
        event["pathParameters"] = path_params
    return event


def _inject(handler, monkeypatch, rule_repo, categories=_CATEGORIES, transaction_repo=None):
    monkeypatch.setattr(handler, "RuleRepository", lambda: rule_repo)
    monkeypatch.setattr(handler, "CategoryRepository", lambda: FakeCategoryRepo(categories))
    # WHIT-540: PUT/DELETE re-file the stored charges a rule touched, so the routes build a
    # TransactionRepository. Default to an empty store here (this suite tests routing/validation,
    # not the re-file — that's test_rule_refile.py).
    monkeypatch.setattr(
        handler, "TransactionRepository", lambda: transaction_repo or WritableFeedRepo({}))


# --- mapper + fold round-trip -------------------------------------------------


def test_create_then_get_preserves_display_value_verbatim(handler, monkeypatch):
    # WHIT-529 — [A1] the handler only strips the ENDS of the value; it must NOT collapse internal
    # whitespace or change case for the stored/displayed value (only the derived id folds). A GET
    # must hand the value back exactly as stored, with categoryId mapped from category_id.
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)

    handler.lambda_handler(
        _event("POST", "/rules", {"value": "  cOlEs  Online  ", "categoryId": "groceries"}), None)

    body = json.loads(handler.lambda_handler(_event("GET", "/rules"), None)["body"])
    assert len(body) == 1
    assert body[0]["value"] == "cOlEs  Online"        # ends trimmed, inner double space + case kept
    assert body[0]["categoryId"] == "groceries"       # category_id -> categoryId mapping


def test_case_and_spacing_variant_dedups_through_the_http_layer(handler, monkeypatch):
    # WHIT-529 — [A2] the derived id folds case + collapses whitespace, so a case/spacing variant of
    # an existing rule is the SAME rule at the store: same category -> 201 dedup (nothing written),
    # different category -> 409. Proves the fold reaches dedup through create_rule_route, not just
    # the repo contract test.
    repo = FakeRuleRepo(rules=[_rule("COLES  EXPRESS", "groceries")])
    _inject(handler, monkeypatch, repo)

    same = handler.lambda_handler(
        _event("POST", "/rules", {"value": "coles express", "categoryId": "groceries"}), None)
    assert same["statusCode"] == 201
    assert repo.minted == []                            # folded variant deduped, nothing written

    clash = handler.lambda_handler(
        _event("POST", "/rules", {"value": "coles express", "categoryId": "petrol"}), None)
    assert clash["statusCode"] == 409
    assert json.loads(clash["body"])["existingRule"]["categoryId"] == "groceries"


def test_create_non_ascii_value_passes_floor_and_round_trips(handler, monkeypatch):
    # WHIT-529 — [A3] a non-ASCII value with >= 4 alphanumerics ("Café" = C,a,f,é) clears the floor
    # (isalnum() counts é) and round-trips through the mapper unchanged.
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)

    resp = handler.lambda_handler(
        _event("POST", "/rules", {"value": "Café", "categoryId": "groceries"}), None)
    assert resp["statusCode"] == 201

    body = json.loads(handler.lambda_handler(_event("GET", "/rules"), None)["body"])
    assert body[0]["value"] == "Café"


# --- value-floor boundary + PUT enforcement -----------------------------------


@pytest.mark.parametrize("value, expected", [
    ("a-b-c", 400),     # 3 letters/digits (hyphens don't count) -> below the floor of 4
    ("a-b-cd", 201),    # 4 letters/digits -> exactly at the floor, accepted
])
def test_value_floor_counts_alphanumerics_only(handler, monkeypatch, value, expected):
    # WHIT-529 — [A4] pins the floor at exactly 4 letters/digits, punctuation excluded. The sibling
    # only tests a hard-fail (".") and the category/equals bypass; this locks the 3-vs-4 boundary so
    # a drift to MIN=3 reddens.
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)
    resp = handler.lambda_handler(
        _event("POST", "/rules", {"value": value, "categoryId": "groceries"}), None)
    assert resp["statusCode"] == expected


def test_value_floor_is_enforced_on_put_text_edit(handler, monkeypatch):
    # WHIT-529 — [A5] the floor guards PUT too, not just POST: editing a safe rule's text down to a
    # near-empty value is rejected 400 BEFORE the store is touched (the old rule survives intact).
    repo = FakeRuleRepo(rules=[_rule("COLESWORTH", "groceries")])
    rule_id = repo.list_rules()[0]["id"]
    _inject(handler, monkeypatch, repo)

    resp = handler.lambda_handler(
        _event("PUT", f"/rules/{rule_id}", {"value": ".", "categoryId": "groceries"},
               path_params={"id": rule_id}), None)
    assert resp["statusCode"] == 400
    assert "letters or digits" in json.loads(resp["body"])["error"]
    assert repo.updated == [] and repo.deleted == []        # store untouched
    assert repo.list_rules()[0]["value"] == "COLESWORTH"    # original still there


# --- a rule whose category was later deleted from the taxonomy ----------------


def test_get_still_returns_a_rule_whose_category_was_deleted(handler, monkeypatch):
    # WHIT-529 — [A7] GET does NOT filter by the taxonomy, so a rule filing into a category the user
    # has since deleted is still returned (the app decides how to surface a dangling category). Pins
    # the "no filter" behaviour so a future taxonomy filter on GET reddens this.
    repo = FakeRuleRepo(rules=[_rule("COLES", "ghost-category")])
    _inject(handler, monkeypatch, repo, categories=_CATEGORIES)   # taxonomy has NO "ghost-category"

    body = json.loads(handler.lambda_handler(_event("GET", "/rules"), None)["body"])
    assert len(body) == 1
    assert body[0]["categoryId"] == "ghost-category"


def test_put_text_only_edit_with_stale_deleted_category_is_400(handler, monkeypatch):
    # WHIT-529 — [A8] the trap the card flags: a rule's category was deleted, the client edits only
    # the rule's TEXT and resends the (now stale) categoryId. The category guard rejects it 400, so a
    # pure text edit is blocked until the user also picks a live category. Documents the coupling.
    repo = FakeRuleRepo(rules=[_rule("COLES", "ghost-category")])
    rule_id = repo.list_rules()[0]["id"]
    _inject(handler, monkeypatch, repo, categories=_CATEGORIES)

    resp = handler.lambda_handler(
        _event("PUT", f"/rules/{rule_id}",
               {"value": "COLES EXPRESS", "categoryId": "ghost-category"},
               path_params={"id": rule_id}), None)
    assert resp["statusCode"] == 400
    assert "categoryId" in json.loads(resp["body"])["error"]
    assert repo.updated == [] and repo.deleted == []        # no move happened


# --- guard precedence ---------------------------------------------------------


def test_below_floor_value_and_unknown_category_returns_the_floor_error_first(handler, monkeypatch):
    # WHIT-529 — [A6] when BOTH guards would fail, the value-floor check runs before the category
    # check, so the client gets the "letters or digits" 400, not the category one. Pins the order.
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)

    resp = handler.lambda_handler(
        _event("POST", "/rules", {"value": ".", "categoryId": "not-a-category"}), None)
    assert resp["statusCode"] == 400
    assert "letters or digits" in json.loads(resp["body"])["error"]


# --- in-place value edit that keeps the id ------------------------------------


def test_case_only_value_edit_keeps_the_id_and_updates_in_place(handler, monkeypatch):
    # WHIT-529 — [A9] editing only the CASE of the value folds to the same id, so it is an in-place
    # update: the response keeps the old id but carries the new (lower-cased) display value, and no
    # row is moved/deleted. Distinct from the sibling's category-change-keeps-id case.
    repo = FakeRuleRepo(rules=[_rule("COLES", "groceries")])
    rule_id = repo.list_rules()[0]["id"]
    _inject(handler, monkeypatch, repo)

    resp = handler.lambda_handler(
        _event("PUT", f"/rules/{rule_id}", {"value": "coles", "categoryId": "groceries"},
               path_params={"id": rule_id}), None)
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 200
    assert body["id"] == rule_id                     # id folds the same, unchanged
    assert body["value"] == "coles"                  # new display value
    assert repo.deleted == []                        # in place, no move
    assert {r["id"] for r in repo.list_rules()} == {rule_id}
