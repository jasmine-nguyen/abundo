"""Tests for the category endpoints (GET/POST /categories) and CategoryRepository.

Handler-level tests inject a FakeCategoryRepo directly (no patching). Repository
tests inject a tiny in-memory fake DynamoDB table into CategoryRepository to prove
the storage logic — most importantly that creating a category on an UNSEEDED
table cannot destroy the 13 seed categories (the bug plan-critic caught).

The `handler` fixture (conftest.py) makes lambda_api importable in isolation and
puts `shared/` on the path, so `import repository` inside a test resolves to
shared/repository.py with boto3/botocore already faked.
"""

import base64
import copy
import json
import re
from collections import Counter
from decimal import Decimal

import pytest
from botocore.exceptions import ClientError

# Pure stdlib, resolved by pytest.ini's `pythonpath = tests/shared` — it needs none of
# the `handler` fixture's sys.path juggling, so it belongs at module scope.
from _chart_ramp import assignment_order as client_assignment_order


# --- handler-level fake ------------------------------------------------------


# Sentinel mirroring the repository's "parent omitted -> leave as-is" default, so
# a handler test can assert the update was called WITHOUT a parent (a plain edit).
_UNSET_FAKE = object()


class FakeCategoryRepo:
    """Handler-level stand-in for CategoryRepository (records calls).

    `create_calls`/`update_calls` stay 4-tuples (id, name, bucket, icon) so the
    pre-parent assertions still hold; the parent argument is recorded separately in
    `create_parents`/`update_parents`.
    """

    def __init__(self, categories=None, duplicate_exc=None, not_found_exc=None,
                 invalid_parent_exc=None):
        self._categories = categories or []
        self._duplicate_exc = duplicate_exc
        self._not_found_exc = not_found_exc
        self._invalid_parent_exc = invalid_parent_exc
        self.create_calls = []
        self.update_calls = []
        self.delete_calls = []
        self.create_parents = []
        self.update_parents = []
        self.list_calls = 0

    def list_categories(self):
        self.list_calls += 1
        return [dict(c) for c in self._categories]

    def create_category(self, cat_id, name, bucket, icon, parent=None):
        self.create_calls.append((cat_id, name, bucket, icon))
        self.create_parents.append(parent)
        if self._duplicate_exc is not None:
            raise self._duplicate_exc(cat_id)
        if self._invalid_parent_exc is not None:
            raise self._invalid_parent_exc("bad parent")
        return {"id": cat_id, "name": name, "icon": icon, "color": "#123456",
                "bucket": bucket, "parent": parent}

    def update_category(self, cat_id, name, bucket, icon, parent=_UNSET_FAKE):
        self.update_calls.append((cat_id, name, bucket, icon))
        self.update_parents.append(parent)
        if self._not_found_exc is not None:
            raise self._not_found_exc(cat_id)
        if self._invalid_parent_exc is not None:
            raise self._invalid_parent_exc("bad parent")
        return {"id": cat_id, "name": name, "icon": icon, "color": "#123456",
                "bucket": bucket, "parent": None if parent is _UNSET_FAKE else parent}

    def delete_category(self, cat_id):
        self.delete_calls.append(cat_id)
        if self._not_found_exc is not None:
            raise self._not_found_exc(cat_id)
        return cat_id


class FakeBudgetRepo:
    """Handler-level stand-in for BudgetRepository — records the cascade delete
    (WHIT-73) and serves a stored-target map so update_category's WHIT-202 Savings
    re-bucket guard can check whether a category is still budgeted. Can be armed to
    raise, to exercise the best-effort cascade path."""

    def __init__(self, raises=None, budgets=None):
        self._raises = raises
        self._budgets = budgets or {}  # {id: {"target": Decimal}}
        self.delete_calls = []
        self.list_calls = 0

    def list_budgets(self):
        self.list_calls += 1
        return {k: dict(v) for k, v in self._budgets.items()}

    def delete_budget(self, cat_id):
        self.delete_calls.append(cat_id)
        if self._raises is not None:
            raise self._raises


def _categories_event(body='{"name": "Gym", "bucket": "Lifestyle", "icon": "dumbbell"}', is_b64=False):
    return {
        "rawPath": "/categories",
        "requestContext": {"http": {"method": "POST"}},
        "body": body,
        "isBase64Encoded": is_b64,
    }


def _category_item_event(method, cat_id="coffee",
                         body='{"name": "Coffee & Cake", "bucket": "Living", "icon": "coffee"}',
                         is_b64=False):
    """Event for the /categories/{id} routes (update/delete)."""
    return {
        "rawPath": f"/categories/{cat_id}",
        "requestContext": {"http": {"method": method}},
        "pathParameters": {"id": cat_id},
        "body": body,
        "isBase64Encoded": is_b64,
    }


# --- handler-level: GET ------------------------------------------------------


def test_list_categories_adds_recent(handler):
    repo = FakeCategoryRepo(categories=[
        {"id": "coffee", "name": "Cafes & Coffee", "icon": "coffee", "color": "#E8A87C", "bucket": "Lifestyle"},
    ])

    result = handler.list_categories(repo)

    assert result == [{
        "id": "coffee", "name": "Cafes & Coffee", "icon": "coffee",
        "color": "#E8A87C", "bucket": "Lifestyle", "recent": 0,
    }]


def test_get_categories_dispatch(handler, monkeypatch):
    repo = FakeCategoryRepo(categories=[
        {"id": "x", "name": "X", "icon": "tag", "color": "#111111", "bucket": "Living"},
    ])
    monkeypatch.setattr(handler, "CategoryRepository", lambda: repo)

    resp = handler.lambda_handler(
        {"rawPath": "/categories", "requestContext": {"http": {"method": "GET"}}}, None)

    assert resp["statusCode"] == 200
    body = json.loads(resp["body"])
    assert body[0]["id"] == "x" and body[0]["recent"] == 0


# --- handler-level: POST -----------------------------------------------------


def test_create_success(handler):
    repo = FakeCategoryRepo()

    resp = handler.create_category(_categories_event(), repo, FakeBudgetRepo())

    assert resp["statusCode"] == 201
    body = json.loads(resp["body"])
    assert body["id"] == "gym" and body["bucket"] == "Lifestyle" and body["recent"] == 0
    assert repo.create_calls == [("gym", "Gym", "Lifestyle", "dumbbell")]


def test_create_slugifies_multiword_name(handler):
    repo = FakeCategoryRepo()

    resp = handler.create_category(
        _categories_event('{"name": "Gym Membership!", "bucket": "Living", "icon": "dumbbell"}'), repo, FakeBudgetRepo())

    assert resp["statusCode"] == 201
    assert repo.create_calls[0][0] == "gymmembership"


def test_create_icon_optional_defaults(handler):
    repo = FakeCategoryRepo()

    resp = handler.create_category(_categories_event('{"name": "Gym", "bucket": "Living"}'), repo, FakeBudgetRepo())

    assert resp["statusCode"] == 201
    assert repo.create_calls[0][3] == "tag"  # DEFAULT_CATEGORY_ICON


def test_create_invalid_bucket_400(handler):
    repo = FakeCategoryRepo()

    resp = handler.create_category(
        _categories_event('{"name": "Gym", "bucket": "Fun", "icon": "x"}'), repo, FakeBudgetRepo())

    assert resp["statusCode"] == 400
    assert repo.create_calls == []


def test_create_missing_name_400(handler):
    repo = FakeCategoryRepo()

    resp = handler.create_category(_categories_event('{"bucket": "Living", "icon": "x"}'), repo, FakeBudgetRepo())

    assert resp["statusCode"] == 400
    assert repo.create_calls == []


def test_create_empty_slug_400(handler):
    # non-empty name, but no slug-safe characters -> empty id -> 400
    repo = FakeCategoryRepo()

    resp = handler.create_category(
        _categories_event('{"name": "!!!", "bucket": "Living", "icon": "x"}'), repo, FakeBudgetRepo())

    assert resp["statusCode"] == 400
    assert repo.create_calls == []


def test_create_duplicate_409(handler):
    repo = FakeCategoryRepo(duplicate_exc=handler.DuplicateCategoryError)

    resp = handler.create_category(_categories_event(), repo, FakeBudgetRepo())

    assert resp["statusCode"] == 409


def test_create_invalid_json_400(handler):
    repo = FakeCategoryRepo()

    resp = handler.create_category(_categories_event("not json"), repo, FakeBudgetRepo())

    assert resp["statusCode"] == 400
    assert repo.create_calls == []


def test_create_base64_body(handler):
    repo = FakeCategoryRepo()
    encoded = base64.b64encode(b'{"name": "Gym", "bucket": "Living", "icon": "dumbbell"}').decode()

    resp = handler.create_category(_categories_event(body=encoded, is_b64=True), repo, FakeBudgetRepo())

    assert resp["statusCode"] == 201
    assert repo.create_calls == [("gym", "Gym", "Living", "dumbbell")]


def test_create_savings_over_orphan_budget_rejected_400(handler):
    # WHIT-202 (qa reverse-order hole): a back-door PUT /budgets/<slug> stores an orphan
    # target before the category exists; creating a Savings category at that same slug would
    # resurrect the un-renderable phantom. The third write-path guard rejects it, and the
    # category is never created. Slug of "Gym" is "gym", so the orphan is keyed there.
    repo = FakeCategoryRepo()
    budget = FakeBudgetRepo(budgets={"gym": {"target": 58}})

    resp = handler.create_category(
        _categories_event('{"name": "Gym", "bucket": "Savings", "icon": "dumbbell"}'), repo, budget)

    assert resp["statusCode"] == 400
    assert repo.create_calls == []       # the Savings category was NOT created


def test_create_savings_without_orphan_budget_allowed(handler):
    # A Savings category with NO pre-existing budget target is a normal, allowed create —
    # the guard blocks only the create-onto-an-orphan-target case.
    repo = FakeCategoryRepo()
    budget = FakeBudgetRepo(budgets={})

    resp = handler.create_category(
        _categories_event('{"name": "Gym", "bucket": "Savings", "icon": "dumbbell"}'), repo, budget)

    assert resp["statusCode"] == 201
    assert repo.create_calls == [("gym", "Gym", "Savings", "dumbbell")]


def test_create_non_savings_over_orphan_budget_allowed(handler):
    # A NON-Savings category can be created over an orphan budget target (the target simply
    # becomes a live budget) — the guard must not over-reach and block that normal case.
    repo = FakeCategoryRepo()
    budget = FakeBudgetRepo(budgets={"gym": {"target": 58}})

    resp = handler.create_category(
        _categories_event('{"name": "Gym", "bucket": "Lifestyle", "icon": "dumbbell"}'), repo, budget)

    assert resp["statusCode"] == 201
    assert repo.create_calls == [("gym", "Gym", "Lifestyle", "dumbbell")]


def test_post_categories_dispatch(handler, monkeypatch):
    repo = FakeCategoryRepo()
    monkeypatch.setattr(handler, "CategoryRepository", lambda: repo)
    monkeypatch.setattr(handler, "BudgetRepository", lambda: FakeBudgetRepo())

    resp = handler.lambda_handler(_categories_event(), None)

    assert resp["statusCode"] == 201
    assert repo.create_calls == [("gym", "Gym", "Lifestyle", "dumbbell")]


# --- repository-level: storage logic via an in-memory fake table -------------


# --- handler-level: PATCH /categories/{id} (update) --------------------------


def test_update_success(handler):
    repo = FakeCategoryRepo()

    resp = handler.update_category(_category_item_event("PATCH"), repo, FakeBudgetRepo())

    assert resp["statusCode"] == 200
    body = json.loads(resp["body"])
    assert body["name"] == "Coffee & Cake" and body["id"] == "coffee" and body["recent"] == 0
    assert repo.update_calls == [("coffee", "Coffee & Cake", "Living", "coffee")]


def test_update_missing_id_returns_404(handler):
    repo = FakeCategoryRepo()
    event = _category_item_event("PATCH")
    event["pathParameters"] = {}

    resp = handler.update_category(event, repo, FakeBudgetRepo())

    assert resp["statusCode"] == 404
    assert repo.update_calls == []


def test_update_blank_name_returns_400(handler):
    repo = FakeCategoryRepo()

    resp = handler.update_category(
        _category_item_event("PATCH", body='{"name": "   ", "bucket": "Living"}'), repo, FakeBudgetRepo())

    assert resp["statusCode"] == 400
    assert repo.update_calls == []


def test_update_invalid_bucket_returns_400(handler):
    repo = FakeCategoryRepo()

    resp = handler.update_category(
        _category_item_event("PATCH", body='{"name": "Coffee", "bucket": "Fun"}'), repo, FakeBudgetRepo())

    assert resp["statusCode"] == 400
    assert repo.update_calls == []


def test_update_invalid_json_returns_400(handler):
    repo = FakeCategoryRepo()

    resp = handler.update_category(_category_item_event("PATCH", body="not json"), repo, FakeBudgetRepo())

    assert resp["statusCode"] == 400
    assert repo.update_calls == []


def test_update_icon_optional_defaults(handler):
    repo = FakeCategoryRepo()

    resp = handler.update_category(
        _category_item_event("PATCH", body='{"name": "Coffee", "bucket": "Living"}'), repo, FakeBudgetRepo())

    assert resp["statusCode"] == 200
    assert repo.update_calls[0][3] == "tag"  # DEFAULT_CATEGORY_ICON


def test_update_unknown_id_returns_404(handler):
    repo = FakeCategoryRepo(not_found_exc=handler.CategoryNotFoundError)

    resp = handler.update_category(_category_item_event("PATCH"), repo, FakeBudgetRepo())

    assert resp["statusCode"] == 404


def test_update_dispatch(handler, monkeypatch):
    repo = FakeCategoryRepo()
    monkeypatch.setattr(handler, "CategoryRepository", lambda: repo)
    monkeypatch.setattr(handler, "BudgetRepository", lambda: FakeBudgetRepo())

    resp = handler.lambda_handler(_category_item_event("PATCH"), None)

    assert resp["statusCode"] == 200
    assert repo.update_calls == [("coffee", "Coffee & Cake", "Living", "coffee")]


def test_update_rebucket_to_savings_while_budgeted_rejected_400(handler):
    # WHIT-202: moving a still-budgeted category into Savings is rejected — a Savings
    # category can't carry a target, so allowing it would strand the budget as an
    # invisible phantom (and resurrect it on a move back). Reject, NOT cascade-delete:
    # the category update never runs and the stored budget is preserved untouched.
    repo = FakeCategoryRepo()
    budget = FakeBudgetRepo(budgets={"coffee": {"target": 58}})

    resp = handler.update_category(
        _category_item_event("PATCH", body='{"name": "Coffee", "bucket": "Savings"}'), repo, budget)

    assert resp["statusCode"] == 400
    assert repo.update_calls == []       # the re-bucket did NOT go through
    assert budget.delete_calls == []     # and the budget was NOT destroyed


def test_update_rebucket_to_savings_without_budget_allowed(handler):
    # A category with NO budget can move into Savings freely — the guard blocks only a
    # still-budgeted one (icon omitted → defaults to "tag").
    repo = FakeCategoryRepo()
    budget = FakeBudgetRepo(budgets={})  # coffee not budgeted

    resp = handler.update_category(
        _category_item_event("PATCH", body='{"name": "Nest Egg", "bucket": "Savings"}'), repo, budget)

    assert resp["statusCode"] == 200
    assert repo.update_calls == [("coffee", "Nest Egg", "Savings", "tag")]


def test_update_budgeted_category_to_non_savings_bucket_unaffected(handler):
    # A budgeted category can still be re-bucketed to any NON-Savings bucket — the guard
    # must not over-reach and block ordinary edits of a budgeted category.
    repo = FakeCategoryRepo()
    budget = FakeBudgetRepo(budgets={"coffee": {"target": 58}})

    resp = handler.update_category(
        _category_item_event("PATCH", body='{"name": "Coffee", "bucket": "Lifestyle"}'), repo, budget)

    assert resp["statusCode"] == 200
    assert repo.update_calls == [("coffee", "Coffee", "Lifestyle", "tag")]


def test_update_rebucket_to_savings_with_zero_target_still_rejected(handler):
    # The guard keys on `cat_id in list_budgets()`; a stored target of 0 is still a KEY
    # there, so a 0-target category is NOT a hole — re-bucketing it into Savings is blocked,
    # never stranding even a $0 phantom. (The client treats 0 as "no budget", so the server
    # is deliberately the stricter side.) Fail-on-revert: drop the guard and this 200s.
    repo = FakeCategoryRepo()
    budget = FakeBudgetRepo(budgets={"coffee": {"target": 0}})

    resp = handler.update_category(
        _category_item_event("PATCH", body='{"name": "Coffee", "bucket": "Savings"}'), repo, budget)

    assert resp["statusCode"] == 400
    assert repo.update_calls == []
    assert budget.delete_calls == []


def test_update_dispatch_rejects_rebucket_to_savings_when_budgeted(handler, monkeypatch):
    # The re-bucket backstop END-TO-END: the REAL router must wire BudgetRepository into
    # update_category so a re-bucket-to-Savings on a still-budgeted category is rejected
    # through dispatch. Fail-on-revert: reverting the router to a 2-arg update_category call
    # raises TypeError (missing budget_repo), so this errors rather than returning 400.
    repo = FakeCategoryRepo()
    monkeypatch.setattr(handler, "CategoryRepository", lambda: repo)
    monkeypatch.setattr(
        handler, "BudgetRepository", lambda: FakeBudgetRepo(budgets={"coffee": {"target": 58}}))

    resp = handler.lambda_handler(
        _category_item_event("PATCH", body='{"name": "Coffee", "bucket": "Savings"}'), None)

    assert resp["statusCode"] == 400
    assert repo.update_calls == []


# --- handler-level: DELETE /categories/{id} ----------------------------------


def test_delete_success(handler):
    repo = FakeCategoryRepo()
    budget = FakeBudgetRepo()

    resp = handler.delete_category(_category_item_event("DELETE", body=None), repo, budget)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"id": "coffee"}
    assert repo.delete_calls == ["coffee"]
    assert budget.delete_calls == ["coffee"]           # WHIT-73: cascade the target


def test_delete_missing_id_returns_404(handler):
    repo = FakeCategoryRepo()
    budget = FakeBudgetRepo()
    event = _category_item_event("DELETE", body=None)
    event["pathParameters"] = {}

    resp = handler.delete_category(event, repo, budget)

    assert resp["statusCode"] == 404
    assert repo.delete_calls == []
    assert budget.delete_calls == []                   # nothing deleted -> no cascade


def test_delete_unknown_id_returns_404(handler):
    repo = FakeCategoryRepo(not_found_exc=handler.CategoryNotFoundError)
    budget = FakeBudgetRepo()

    resp = handler.delete_category(_category_item_event("DELETE", body=None), repo, budget)

    assert resp["statusCode"] == 404
    # Category delete failed -> the cascade must NOT run (never touch the budget of a
    # category that still exists).
    assert budget.delete_calls == []


def test_delete_cascade_conflict_is_best_effort(handler):
    # A version conflict on the cascade must NOT fail the delete — the category is
    # already gone; the orphan just persists (today's behaviour). Returns 200.
    repo = FakeCategoryRepo()
    budget = FakeBudgetRepo(raises=handler.VersionConflictError("contention"))

    resp = handler.delete_category(_category_item_event("DELETE", body=None), repo, budget)

    assert resp["statusCode"] == 200
    assert budget.delete_calls == ["coffee"]


def test_delete_cascade_db_error_is_best_effort(handler):
    # Same tolerance for a DB fault surfaced as DatabaseError by handle_database_error
    # (WHIT-127): the narrowed cascade catch must still swallow it and return 200.
    repo = FakeCategoryRepo()
    budget = FakeBudgetRepo(raises=handler.DatabaseError("Database delete budget failed"))

    resp = handler.delete_category(_category_item_event("DELETE", body=None), repo, budget)

    assert resp["statusCode"] == 200


def test_delete_cascade_non_db_runtimeerror_is_not_swallowed(handler):
    # WHIT-127's whole point: the cascade catch is now DatabaseError-specific, so an
    # UNRELATED RuntimeError (a logic bug in delete_budget, not a DB fault) must NOT
    # be masked as a best-effort 200 — it propagates (→ Lambda 500) so the bug
    # surfaces. Fail-on-revert: widening the catch back to RuntimeError reddens this.
    repo = FakeCategoryRepo()
    budget = FakeBudgetRepo(raises=RuntimeError("bug: not a DB error"))

    with pytest.raises(RuntimeError, match="bug"):
        handler.delete_category(_category_item_event("DELETE", body=None), repo, budget)


def test_delete_dispatch(handler, monkeypatch):
    repo = FakeCategoryRepo()
    budget = FakeBudgetRepo()
    monkeypatch.setattr(handler, "CategoryRepository", lambda: repo)
    monkeypatch.setattr(handler, "BudgetRepository", lambda: budget)

    resp = handler.lambda_handler(_category_item_event("DELETE", body=None), None)

    assert resp["statusCode"] == 200
    assert repo.delete_calls == ["coffee"]
    assert budget.delete_calls == ["coffee"]           # route wires the cascade


def _ccfe():
    err = ClientError()
    err.response = {"Error": {"Code": "ConditionalCheckFailedException"}}
    return err


# DynamoDB's documented UpdateExpression ceiling. FakeTable enforces it so an expression that
# the real service would reject cannot pass in tests — without this, WHIT-405's chunk cap
# could be deleted and every test would still be green.
_MAX_UPDATE_EXPRESSION_BYTES = 4096


def _validation_error(message):
    err = ClientError()
    # Message, not just Code: handle_database_error reads BOTH (shared/repository_base.py),
    # so a Message-less response raises KeyError instead of the DatabaseError under test.
    err.response = {"Error": {"Code": "ValidationException", "Message": message}}
    return err


class FakeTable:
    """In-memory table emulating only the calls CategoryRepository makes:
    get_item, conditional put_item, and the nested conditional update_item."""

    def __init__(self):
        self.store = {}  # (pk, sk) -> item
        # Queue of callables(item) run just before each update_item evaluation,
        # to simulate a concurrent writer mutating the row between read and write.
        self.before_update = []
        # Every update_item call, so a test can assert a migrated store writes ZERO times.
        self.update_calls = []
        # When set, every update_item raises it — used to prove the read path fails OPEN.
        self.update_error = None

    def get_item(self, Key):
        item = self.store.get((Key["pk"], Key["sk"]))
        return {"Item": copy.deepcopy(item)} if item is not None else {}

    def put_item(self, Item, ConditionExpression=None):
        k = (Item["pk"], Item["sk"])
        if ConditionExpression == "attribute_not_exists(pk)" and k in self.store:
            raise _ccfe()
        self.store[k] = copy.deepcopy(Item)

    def update_item(self, Key, UpdateExpression, ConditionExpression,
                    ExpressionAttributeNames, ExpressionAttributeValues):
        item = self.store.get((Key["pk"], Key["sk"]))
        if self.before_update and item is not None:
            self.before_update.pop(0)(item)  # simulate a concurrent writer
        values = ExpressionAttributeValues
        self.update_calls.append(
            (UpdateExpression, dict(ExpressionAttributeNames), dict(values))
        )
        if self.update_error is not None:
            raise self.update_error
        expression_bytes = len(UpdateExpression.encode())
        if expression_bytes > _MAX_UPDATE_EXPRESSION_BYTES:
            raise _validation_error(
                f"Invalid UpdateExpression: expression is too large; "
                f"{expression_bytes} bytes exceeds the {_MAX_UPDATE_EXPRESSION_BYTES} limit"
            )

        # The colour-slot backfill is its own shape: it stamps #schema and/or one
        # #items.#catN.#slot per category. It carries no #id, so it must be handled before
        # the create/rename/delete paths read one. Route on that ABSENCE, not on a positive
        # guess at the backfill's own aliases: since WHIT-405 a partial chunk carries no
        # #schema, and a future write declaring both #id and #slot would be mis-routed here,
        # match nothing in the #cat loop, and be silently dropped while the test went green.
        if "#id" not in ExpressionAttributeNames:
            if item is None or item["version"] != values[":expected"]:
                raise _ccfe()
            # DynamoDB rejects a declared-but-unreferenced name; mirror that so a regression
            # here fails loudly in tests instead of silently passing.
            for alias in ExpressionAttributeNames:
                # Word-boundary, not substring: "#cat1" occurs inside "#cat10", so a plain
                # `in` check silently passes the very regression this guard exists for.
                assert re.search(rf"{re.escape(alias)}(?![0-9])", UpdateExpression), \
                    f"unused ExpressionAttributeName {alias}"
            for alias, real in ExpressionAttributeNames.items():
                if alias.startswith("#cat"):
                    index = alias[len("#cat"):]
                    item["items"][real]["colorSlot"] = values[f":slot{index}"]
            # A partial chunk carries no :schema — the store stays unmarked so the remaining
            # categories get picked up by a later request.
            if ":schema" in values:
                item["colorSlotSchema"] = values[":schema"]
            item["version"] = values[":next"]
            return

        cat_id = ExpressionAttributeNames["#id"]

        # attribute_exists(pk) AND #v = :expected are common to create/rename/delete.
        if item is None or item["version"] != values[":expected"]:
            raise _ccfe()

        if UpdateExpression.startswith("REMOVE"):
            # delete: guard attribute_exists(items.<id>)
            if cat_id not in item["items"]:
                raise _ccfe()
            del item["items"][cat_id]
            # Promote any children to top-level (parent -> None) — aliased #childN.
            for alias, real in ExpressionAttributeNames.items():
                if alias.startswith("#child"):
                    item["items"][real]["parent"] = values[":null"]
        elif "#items.#id.#name" in UpdateExpression:
            # update: guard attribute_exists(items.<id>); sets name, bucket, icon
            if cat_id not in item["items"]:
                raise _ccfe()
            item["items"][cat_id]["name"] = values[":name"]
            item["items"][cat_id]["bucket"] = values[":bucket"]
            item["items"][cat_id]["icon"] = values[":icon"]
            if "#items.#id.#parent" in UpdateExpression:
                item["items"][cat_id]["parent"] = values[":parent"]
        else:
            # create: guard attribute_not_exists(items.<id>)
            if cat_id in item["items"]:
                raise _ccfe()
            item["items"][cat_id] = copy.deepcopy(values[":cat"])

        item["version"] = values[":next"]


def _repo_with_fake_table(handler):
    import repository
    repo = repository.CategoryRepository()
    repo._table = FakeTable()
    return repository, repo


def test_repo_create_on_empty_table_preserves_seeds(handler):
    # THE regression: create on a never-seeded table must not wipe the 13 seeds.
    repository, repo = _repo_with_fake_table(handler)

    created = repo.create_category("gym", "Gym", "Lifestyle", "dumbbell")

    stored = repo._table.store[("CATEGORIES", "CATEGORIES")]
    assert len(stored["items"]) == 14  # 13 seeds + gym
    assert set(repository.SEED_CATEGORIES).issubset(stored["items"].keys())
    assert "gym" in stored["items"]
    assert stored["version"] == 2
    assert created["id"] == "gym"


def test_repo_create_color_is_post_seed(handler):
    repository, repo = _repo_with_fake_table(handler)

    created = repo.create_category("gym", "Gym", "Lifestyle", "dumbbell")

    # count after seeding is 13 -> palette index 13 % 10, never a seed's index 0
    palette = repository.CATEGORY_PALETTE
    assert created["color"] == palette[13 % len(palette)]


def test_repo_list_seeds_then_is_stable(handler):
    repository, repo = _repo_with_fake_table(handler)

    first = repo.list_categories()
    second = repo.list_categories()  # must not re-seed or duplicate

    assert len(first) == 13
    assert len(second) == 13
    assert repo._table.store[("CATEGORIES", "CATEGORIES")]["version"] == 1


def test_repo_create_duplicate_raises(handler):
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()  # seed

    try:
        repo.create_category("coffee", "Coffee", "Lifestyle", "coffee")
        assert False, "expected DuplicateCategoryError"
    except repository.DuplicateCategoryError:
        pass


# --- repository-level: the optimistic-lock concurrency branches ---------------


def _bump_version(item):
    item["version"] = item["version"] + 1  # Decimal + int -> Decimal


def test_repo_create_retries_after_version_race(handler):
    # A concurrent writer bumps the version once between our read and write; the
    # first update hits CCFE (id still free) and the retry succeeds — seeds intact.
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()  # seed -> version 1
    repo._table.before_update.append(_bump_version)

    created = repo.create_category("gym", "Gym", "Lifestyle", "dumbbell")

    stored = repo._table.store[("CATEGORIES", "CATEGORIES")]
    assert created["id"] == "gym"
    assert "gym" in stored["items"] and len(stored["items"]) == 14  # seeds not lost
    assert stored["version"] == 3  # concurrent bump (1->2) + our write (2->3)


def test_repo_create_ccfe_resolves_to_duplicate(handler):
    # A concurrent writer creates the SAME id between our read and write; the CCFE
    # must be classified as a duplicate (409), not retried.
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()  # seed

    def add_same(item):
        item["items"]["gym"] = {"id": "gym", "name": "Gym", "icon": "tag",
                                "color": "#000000", "bucket": "Living"}
    repo._table.before_update.append(add_same)

    try:
        repo.create_category("gym", "Gym", "Lifestyle", "dumbbell")
        assert False, "expected DuplicateCategoryError"
    except repository.DuplicateCategoryError:
        pass


def test_repo_create_raises_under_sustained_contention(handler):
    # Every attempt sees a fresh version bump (id stays free) -> never converges.
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()  # seed
    repo._table.before_update.extend([_bump_version, _bump_version])

    try:
        repo.create_category("gym", "Gym", "Lifestyle", "dumbbell")
        assert False, "expected VersionConflictError under sustained contention"
    except repository.VersionConflictError:
        pass


def test_create_version_conflict_returns_409(handler, monkeypatch):
    # A repo that exhausts its retry budget raises VersionConflictError; the shared
    # dispatch wrapper maps it to 409 (same path budgets use).
    class ConflictingRepo:
        def create_category(self, *args, **kwargs):
            raise handler.VersionConflictError("boom")

    monkeypatch.setattr(handler, "CategoryRepository", lambda: ConflictingRepo())
    monkeypatch.setattr(handler, "BudgetRepository", lambda: FakeBudgetRepo())

    resp = handler.lambda_handler(_categories_event(), None)

    assert resp["statusCode"] == 409


# --- repository-level: update ------------------------------------------------


def test_repo_update_changes_editable_fields(handler):
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()  # seed

    updated = repo.update_category("coffee", "Coffee & Cake", "Living", "cart")

    config = repo._table.store[("CATEGORIES", "CATEGORIES")]
    stored = config["items"]["coffee"]
    # name/bucket/icon changed; id/color preserved; still 13 categories; version bumped
    assert stored["name"] == "Coffee & Cake" and stored["bucket"] == "Living" and stored["icon"] == "cart"
    assert stored["id"] == "coffee" and stored["color"] == "#E8A87C"
    assert len(config["items"]) == 13 and config["version"] == 2
    # colorSlot rides through an edit untouched — a rename must never repaint a category.
    assert updated == {"id": "coffee", "name": "Coffee & Cake", "icon": "cart",
                       "color": "#E8A87C", "bucket": "Living", "parent": None, "colorSlot": 9}


def test_repo_update_unknown_id_raises(handler):
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()  # seed
    try:
        repo.update_category("nope", "Nope", "Living", "tag")
        assert False, "expected CategoryNotFoundError"
    except repository.CategoryNotFoundError:
        pass


def test_repo_update_retries_after_version_race(handler):
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()  # seed -> version 1
    repo._table.before_update.append(_bump_version)

    repo.update_category("coffee", "Coffee & Cake", "Living", "cart")

    config = repo._table.store[("CATEGORIES", "CATEGORIES")]
    assert config["items"]["coffee"]["name"] == "Coffee & Cake"
    assert config["version"] == 3  # concurrent bump (1->2) + our write (2->3)


def test_repo_update_concurrently_deleted_raises(handler):
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()  # seed
    repo._table.before_update.append(lambda item: item["items"].pop("coffee", None))
    try:
        repo.update_category("coffee", "Coffee & Cake", "Living", "cart")
        assert False, "expected CategoryNotFoundError"
    except repository.CategoryNotFoundError:
        pass


# --- repository-level: delete ------------------------------------------------


def test_repo_delete_removes_key(handler):
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()  # seed

    removed = repo.delete_category("coffee")

    config = repo._table.store[("CATEGORIES", "CATEGORIES")]
    assert removed == "coffee"
    assert "coffee" not in config["items"] and len(config["items"]) == 12
    assert config["version"] == 2


def test_repo_delete_unknown_id_raises(handler):
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()  # seed
    try:
        repo.delete_category("nope")
        assert False, "expected CategoryNotFoundError"
    except repository.CategoryNotFoundError:
        pass


def test_repo_delete_retries_after_version_race(handler):
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()  # seed
    repo._table.before_update.append(_bump_version)

    repo.delete_category("coffee")

    config = repo._table.store[("CATEGORIES", "CATEGORIES")]
    assert "coffee" not in config["items"] and config["version"] == 3


def test_repo_delete_concurrently_deleted_raises(handler):
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()  # seed
    repo._table.before_update.append(lambda item: item["items"].pop("coffee", None))
    try:
        repo.delete_category("coffee")
        assert False, "expected CategoryNotFoundError"
    except repository.CategoryNotFoundError:
        pass


# --- sub-categories: parent link (WHIT-217 slice 1) --------------------------
#
# `parent` is optional on a category: None/absent = top-level, else the id of the
# parent it rolls up into. Slice 1 stores + validates the link end-to-end; no
# rollup or tree UI yet. Same-bucket, existence, cycle, and self rules are enforced.


def test_repo_list_defaults_parent_to_none_for_legacy_rows(handler):
    # Seed rows are stored WITHOUT a parent key (written before the field existed);
    # every category leaving the repo must still carry parent, defaulted to None.
    repository, repo = _repo_with_fake_table(handler)

    cats = repo.list_categories()

    assert cats and all("parent" in c for c in cats)
    assert all(c["parent"] is None for c in cats)


def test_repo_create_with_valid_parent_stores_it(handler):
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()  # seed; "transport" is a Living seed

    created = repo.create_category("parking", "Parking", "Living", "car", parent="transport")

    assert created["parent"] == "transport"
    stored = repo._table.store[("CATEGORIES", "CATEGORIES")]["items"]["parking"]
    assert stored["parent"] == "transport"
    # and it round-trips through list_categories
    parking = next(c for c in repo.list_categories() if c["id"] == "parking")
    assert parking["parent"] == "transport"


def test_repo_create_unknown_parent_raises(handler):
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()  # seed

    try:
        repo.create_category("parking", "Parking", "Living", "car", parent="nope")
        assert False, "expected InvalidCategoryParentError"
    except repository.InvalidCategoryParentError:
        pass
    # nothing stored
    assert "parking" not in repo._table.store[("CATEGORIES", "CATEGORIES")]["items"]


def test_repo_create_cross_bucket_parent_raises(handler):
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()  # seed; "transport" is Living, child asks for Lifestyle

    try:
        repo.create_category("parking", "Parking", "Lifestyle", "car", parent="transport")
        assert False, "expected InvalidCategoryParentError (bucket mismatch)"
    except repository.InvalidCategoryParentError:
        pass


def test_repo_create_self_parent_raises(handler):
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()  # seed

    try:
        repo.create_category("parking", "Parking", "Living", "car", parent="parking")
        assert False, "expected InvalidCategoryParentError (self-parent)"
    except repository.InvalidCategoryParentError:
        pass


def test_repo_update_reparents_and_detaches(handler):
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()  # seed; groceries + transport are both Living

    updated = repo.update_category("groceries", "Groceries", "Living", "cart", parent="transport")
    assert updated["parent"] == "transport"
    assert repo._table.store[("CATEGORIES", "CATEGORIES")]["items"]["groceries"]["parent"] == "transport"

    # Passing None detaches back to top-level.
    detached = repo.update_category("groceries", "Groceries", "Living", "cart", parent=None)
    assert detached["parent"] is None
    assert repo._table.store[("CATEGORIES", "CATEGORIES")]["items"]["groceries"]["parent"] is None


def test_repo_update_omitting_parent_preserves_the_link(handler):
    # THE clobber-guard (fail-on-revert target): once a category has a parent, an
    # ordinary name/icon edit that omits `parent` must NOT wipe the link. Reverting
    # update_category to always SET parent reddens this.
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()  # seed
    repo.update_category("groceries", "Groceries", "Living", "cart", parent="transport")

    # A plain rename, no parent argument.
    repo.update_category("groceries", "Food Shop", "Living", "cart")

    stored = repo._table.store[("CATEGORIES", "CATEGORIES")]["items"]["groceries"]
    assert stored["name"] == "Food Shop"
    assert stored["parent"] == "transport"  # link survived the edit


def test_repo_update_parent_cycle_raises(handler):
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()  # seed
    repo.update_category("groceries", "Groceries", "Living", "cart", parent="transport")

    # transport -> groceries would close the loop groceries -> transport -> groceries.
    try:
        repo.update_category("transport", "Transport", "Living", "car", parent="groceries")
        assert False, "expected InvalidCategoryParentError (cycle)"
    except repository.InvalidCategoryParentError:
        pass


def test_repo_update_bucket_change_with_children_raises(handler):
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()  # seed
    repo.update_category("groceries", "Groceries", "Living", "cart", parent="transport")

    # transport now has a child; moving transport to another bucket would break the
    # same-bucket rule for groceries -> refused.
    try:
        repo.update_category("transport", "Transport", "Lifestyle", "car")
        assert False, "expected InvalidCategoryParentError (bucket change with children)"
    except repository.InvalidCategoryParentError:
        pass


def test_repo_update_sub_cannot_rebucket_away_from_parent(handler):
    # A sub-category must stay in its parent's bucket. A plain edit (no parent in the
    # body) that flips the child's OWN bucket must be refused, or the sub would drift
    # out of its parent's bucket. Fail-on-revert: dropping the stored-parent re-check
    # in update_category lets this through.
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()  # seed; groceries + transport both Living
    repo.update_category("groceries", "Groceries", "Living", "cart", parent="transport")

    try:
        repo.update_category("groceries", "Groceries", "Lifestyle", "cart")
        assert False, "expected InvalidCategoryParentError (sub re-bucketed away from parent)"
    except repository.InvalidCategoryParentError:
        pass
    # unchanged: still Living, still under transport
    stored = repo._table.store[("CATEGORIES", "CATEGORIES")]["items"]["groceries"]
    assert stored["bucket"] == "Living" and stored["parent"] == "transport"


def test_repo_delete_promotes_children_to_top_level(handler):
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()  # seed
    repo.update_category("groceries", "Groceries", "Living", "cart", parent="transport")
    repo.update_category("health", "Health", "Living", "health", parent="transport")

    repo.delete_category("transport")

    items = repo._table.store[("CATEGORIES", "CATEGORIES")]["items"]
    assert "transport" not in items
    assert items["groceries"]["parent"] is None  # promoted to top-level
    assert items["health"]["parent"] is None
    assert "groceries" in items and "health" in items  # children NOT deleted


def test_validate_category_parent_pure_rules(handler):
    # Direct unit tests of the pure helper, independent of DynamoDB.
    import repository
    items = {
        "a": {"id": "a", "bucket": "Living", "parent": None},
        "b": {"id": "b", "bucket": "Living", "parent": "a"},
        "inc": {"id": "inc", "bucket": "Income", "parent": None},
    }
    # Valid: same bucket, no cycle.
    repository.validate_category_parent(items, "c", "a", "Living")
    # Cycle: making a's parent b, where b already descends from a.
    with pytest.raises(repository.InvalidCategoryParentError):
        repository.validate_category_parent(items, "a", "b", "Living")
    # Cross-bucket.
    with pytest.raises(repository.InvalidCategoryParentError):
        repository.validate_category_parent(items, "c", "inc", "Living")
    # Unknown parent.
    with pytest.raises(repository.InvalidCategoryParentError):
        repository.validate_category_parent(items, "c", "ghost", "Living")


# --- handler-level: parent pass-through & validation -------------------------


def test_create_passes_parent_through(handler):
    repo = FakeCategoryRepo()

    resp = handler.create_category(
        _categories_event('{"name": "Parking", "bucket": "Living", "icon": "car", "parent": "transport"}'),
        repo, FakeBudgetRepo())

    assert resp["statusCode"] == 201
    assert repo.create_parents == ["transport"]
    assert json.loads(resp["body"])["parent"] == "transport"


def test_create_without_parent_defaults_to_none(handler):
    repo = FakeCategoryRepo()

    resp = handler.create_category(_categories_event(), repo, FakeBudgetRepo())

    assert resp["statusCode"] == 201
    assert repo.create_parents == [None]


def test_create_invalid_parent_type_400(handler):
    repo = FakeCategoryRepo()

    resp = handler.create_category(
        _categories_event('{"name": "Parking", "bucket": "Living", "icon": "car", "parent": 5}'),
        repo, FakeBudgetRepo())

    assert resp["statusCode"] == 400
    assert repo.create_calls == []  # never reached the repo


def test_create_parent_rejected_by_repo_400(handler):
    repo = FakeCategoryRepo(invalid_parent_exc=handler.InvalidCategoryParentError)

    resp = handler.create_category(
        _categories_event('{"name": "Parking", "bucket": "Living", "icon": "car", "parent": "transport"}'),
        repo, FakeBudgetRepo())

    assert resp["statusCode"] == 400


def test_update_omitting_parent_leaves_link_untouched(handler):
    # No "parent" key in the body -> the repo is called WITHOUT parent (leave-as-is),
    # not with parent=None. Fail-on-revert: passing None here would let a rename wipe
    # a stored link.
    repo = FakeCategoryRepo()

    resp = handler.update_category(_category_item_event("PATCH"), repo, FakeBudgetRepo())

    assert resp["statusCode"] == 200
    assert repo.update_parents == [_UNSET_FAKE]


def test_update_passes_parent_when_present(handler):
    repo = FakeCategoryRepo()

    resp = handler.update_category(
        _category_item_event("PATCH", body='{"name": "Coffee", "bucket": "Living", "parent": "transport"}'),
        repo, FakeBudgetRepo())

    assert resp["statusCode"] == 200
    assert repo.update_parents == ["transport"]


def test_update_explicit_null_parent_detaches(handler):
    repo = FakeCategoryRepo()

    resp = handler.update_category(
        _category_item_event("PATCH", body='{"name": "Coffee", "bucket": "Living", "parent": null}'),
        repo, FakeBudgetRepo())

    assert resp["statusCode"] == 200
    assert repo.update_parents == [None]


def test_update_parent_rejected_by_repo_400(handler):
    repo = FakeCategoryRepo(invalid_parent_exc=handler.InvalidCategoryParentError)

    resp = handler.update_category(
        _category_item_event("PATCH", body='{"name": "Coffee", "bucket": "Living", "parent": "transport"}'),
        repo, FakeBudgetRepo())

    assert resp["statusCode"] == 400


# --- QA gap tests (WHIT-217 slice 1): adversarial edges beyond the above ------
# The corruption fall-through in the ancestor walk, re-parent surviving an
# optimistic-lock retry, deep (3-level) chains, delete-promote of a MIDDLE node,
# delete-promote crossed with the WHIT-73 budget cascade, and whitespace/trim
# parsing of the parent string. Reuses the existing suite fixtures/helpers.


def test_validate_parent_stored_cycle_not_touching_cat_hits_walk_guard(handler):
    # The `_MAX_PARENT_WALK` fall-through raise. The other cycle tests all close a
    # loop THROUGH cat_id (the `ancestor == cat_id` early raise). This exercises the
    # bound raise: a pre-existing corrupt cycle among ancestors that never reaches
    # cat_id, so only the loop bound stops an infinite walk.
    import repository
    items = {
        "x": {"id": "x", "bucket": "Living", "parent": "y"},
        "y": {"id": "y", "bucket": "Living", "parent": "x"},  # x<->y already a cycle
    }
    with pytest.raises(repository.InvalidCategoryParentError):
        repository.validate_category_parent(items, "new", "x", "Living")


def test_validate_parent_deep_chain_valid_and_deep_cycle_rejected(handler):
    # 3+ levels. A valid deep parent must walk to the root and pass; a cycle that only
    # closes three hops up must still be caught (not just the 2-level case).
    import repository
    items = {
        "a": {"id": "a", "bucket": "Living", "parent": None},
        "b": {"id": "b", "bucket": "Living", "parent": "a"},
        "c": {"id": "c", "bucket": "Living", "parent": "b"},  # a <- b <- c
    }
    repository.validate_category_parent(items, "d", "c", "Living")  # valid deep leaf
    with pytest.raises(repository.InvalidCategoryParentError):
        repository.validate_category_parent(items, "a", "c", "Living")  # deep cycle


# --- WHIT-223: maximum nesting depth (5 levels, top-level = level 1) ----------


def test_validate_depth_allows_a_fifth_level_and_rejects_a_sixth(handler):
    # Chain a(1) <- b(2) <- c(3) <- d(4). A new leaf under d lands at level 5 -> allowed;
    # once that leaf e(5) exists, a node under it would be level 6 -> rejected with the
    # plain user-facing message. Fail-on-revert: without the depth check the second call
    # doesn't raise.
    import repository
    items = {
        "a": {"id": "a", "bucket": "Living", "parent": None},
        "b": {"id": "b", "bucket": "Living", "parent": "a"},
        "c": {"id": "c", "bucket": "Living", "parent": "b"},
        "d": {"id": "d", "bucket": "Living", "parent": "c"},
    }
    repository.validate_category_depth(items, "e", "d")   # 4 + 1 = 5, allowed
    items["e"] = {"id": "e", "bucket": "Living", "parent": "d"}
    with pytest.raises(repository.InvalidCategoryParentError, match="5 levels"):
        repository.validate_category_depth(items, "f", "e")   # 5 + 1 = 6, rejected


def test_validate_depth_reparent_uses_subtree_height_not_node_count(handler):
    # THE height-vs-count case (fail-on-revert of a count-based helper): x has TWO leaf
    # children, so its subtree is 3 NODES but only 2 LEVELS tall. Moving x under a level-3
    # node lands its deepest leaf at 3 + 2 = 5 -> allowed. A descendant-COUNT rollup would
    # read 3 + 3 = 6 and wrongly reject a perfectly shallow tree.
    import repository
    items = {
        "top": {"id": "top", "bucket": "Living", "parent": None},
        "mid": {"id": "mid", "bucket": "Living", "parent": "top"},
        "q": {"id": "q", "bucket": "Living", "parent": "mid"},        # q is level 3
        "x": {"id": "x", "bucket": "Living", "parent": None},
        "c1": {"id": "c1", "bucket": "Living", "parent": "x"},
        "c2": {"id": "c2", "bucket": "Living", "parent": "x"},        # x is 2 levels tall
    }
    repository.validate_category_depth(items, "x", "q")   # 3 + 2 = 5, allowed (must not raise)


def test_validate_depth_reparent_measures_whole_moved_subtree(handler):
    # x <- y <- z: x is 3 levels tall. Under a level-2 node: 2 + 3 = 5 allowed; under a
    # level-3 node: 3 + 3 = 6 rejected -> proves the deepest DESCENDANT is what's bounded,
    # not just the moved node itself.
    import repository
    items = {
        "p": {"id": "p", "bucket": "Living", "parent": None},
        "q": {"id": "q", "bucket": "Living", "parent": "p"},          # level 2
        "r": {"id": "r", "bucket": "Living", "parent": "q"},          # level 3
        "x": {"id": "x", "bucket": "Living", "parent": None},
        "y": {"id": "y", "bucket": "Living", "parent": "x"},
        "z": {"id": "z", "bucket": "Living", "parent": "y"},          # x is 3 levels tall
    }
    repository.validate_category_depth(items, "x", "q")   # 2 + 3 = 5, allowed
    with pytest.raises(repository.InvalidCategoryParentError, match="5 levels"):
        repository.validate_category_depth(items, "x", "r")   # 3 + 3 = 6, rejected


def test_validate_depth_is_cycle_safe(handler):
    # Corrupt stored cycles must terminate both walks (fail-on-revert: dropping the
    # `visited` guard hangs). An up-cycle among the parent's ancestors and a down-cycle
    # in the moved subtree both return without looping.
    import repository
    up_cycle = {
        "a": {"id": "a", "bucket": "Living", "parent": "b"},
        "b": {"id": "b", "bucket": "Living", "parent": "a"},   # a<->b
    }
    repository.validate_category_depth(up_cycle, "new", "a")    # bounded depth, no hang
    down_cycle = {
        "top": {"id": "top", "bucket": "Living", "parent": None},
        "x": {"id": "x", "bucket": "Living", "parent": "y"},
        "y": {"id": "y", "bucket": "Living", "parent": "x"},   # x<->y
    }
    repository.validate_category_depth(down_cycle, "x", "top")  # bounded height, no hang


def test_repo_create_at_max_depth_allowed_and_beyond_rejected(handler):
    # End-to-end via create_category: build a chain to level 5 under the top-level
    # "transport" seed (level 1), then a 6th level is refused with nothing stored.
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()  # seed; transport is a top-level Living category (level 1)
    repo.create_category("l2", "L2", "Living", "car", parent="transport")  # level 2
    repo.create_category("l3", "L3", "Living", "car", parent="l2")          # level 3
    repo.create_category("l4", "L4", "Living", "car", parent="l3")          # level 4
    repo.create_category("l5", "L5", "Living", "car", parent="l4")          # level 5 — allowed
    assert repo._table.store[("CATEGORIES", "CATEGORIES")]["items"]["l5"]["parent"] == "l4"

    with pytest.raises(repository.InvalidCategoryParentError, match="5 levels"):
        repo.create_category("l6", "L6", "Living", "car", parent="l5")      # level 6 — rejected
    assert "l6" not in repo._table.store[("CATEGORIES", "CATEGORIES")]["items"]


def test_repo_reparent_beyond_max_depth_rejected_link_unchanged(handler):
    # Re-parent an existing subtree so its deepest node would exceed level 5 -> rejected,
    # and the stored parent link is untouched.
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()  # seed
    repo.create_category("l2", "L2", "Living", "car", parent="transport")   # transport(1)<-l2(2)
    repo.create_category("l3", "L3", "Living", "car", parent="l2")          # <-l3(3)
    repo.create_category("l4", "L4", "Living", "car", parent="l3")          # <-l4(4)
    repo.create_category("gsub", "GSub", "Living", "cart", parent="groceries")  # groceries 2 tall

    # Re-parent groceries (2 tall) under l4 (level 4): 4 + 2 = 6 -> rejected.
    with pytest.raises(repository.InvalidCategoryParentError, match="5 levels"):
        repo.update_category("groceries", "Groceries", "Living", "cart", parent="l4")
    assert repo._table.store[("CATEGORIES", "CATEGORIES")]["items"]["groceries"].get("parent") is None


def test_repo_reparent_to_top_level_always_allowed(handler):
    # Detaching (parent=None) skips depth validation entirely, so a node can always be
    # lifted to the top regardless of where it sat.
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()
    repo.create_category("l2", "L2", "Living", "car", parent="transport")
    repo.create_category("l3", "L3", "Living", "car", parent="l2")

    detached = repo.update_category("l3", "L3", "Living", "car", parent=None)
    assert detached["parent"] is None


def test_repo_grandfathered_over_deep_chain_stays_editable(handler):
    # Decision 2: the cap is enforced only on writes that ADD depth (create-with-parent,
    # re-parent). A chain already deeper than the cap (written before the cap existed) must
    # stay editable — an ordinary name/icon edit that doesn't touch the parent is never
    # blocked by the depth rule.
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()  # seed
    items = repo._table.store[("CATEGORIES", "CATEGORIES")]["items"]
    prev = "transport"
    for i in range(2, 7):   # hand-build levels 2..6, bypassing the cap (as legacy data would)
        cid = f"d{i}"
        items[cid] = {"id": cid, "name": cid, "icon": "car", "color": "#fff",
                      "bucket": "Living", "parent": prev}
        prev = cid

    updated = repo.update_category("d6", "Renamed", "Living", "car")   # plain rename, no parent
    assert updated["name"] == "Renamed"
    assert repo._table.store[("CATEGORIES", "CATEGORIES")]["items"]["d6"]["parent"] == "d5"


def test_repo_reparent_survives_version_race_retry(handler):
    # A concurrent writer bumps the version between our read and write, so the first
    # re-parent write hits CCFE and retries. The parent write must survive the retry
    # (the SET clause is rebuilt each attempt), not silently drop.
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()  # seed -> version 1; groceries + transport both Living
    repo._table.before_update.append(_bump_version)

    updated = repo.update_category("groceries", "Groceries", "Living", "cart", parent="transport")

    stored = repo._table.store[("CATEGORIES", "CATEGORIES")]
    assert updated["parent"] == "transport"
    assert stored["items"]["groceries"]["parent"] == "transport"  # not dropped on retry
    assert stored["version"] == 3  # concurrent bump (1->2) + our write (2->3)


def test_repo_delete_middle_node_promotes_only_direct_children(handler):
    # Deleting a middle node promotes its DIRECT children to top-level (parent -> None),
    # NOT to the grandparent, and leaves grandchildren untouched.
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()  # seed
    repo.update_category("groceries", "Groceries", "Living", "cart", parent="transport")
    repo.update_category("health", "Health", "Living", "health", parent="groceries")  # transport<-groceries<-health

    repo.delete_category("transport")

    items = repo._table.store[("CATEGORIES", "CATEGORIES")]["items"]
    assert "transport" not in items
    assert items["groceries"]["parent"] is None       # direct child promoted
    assert items["health"]["parent"] == "groceries"   # grandchild untouched


def test_delete_parent_promotes_children_and_cascades_only_parent_budget(handler):
    # Real repo (fake table) delete + real handler cascade. Deleting a parent must
    # (a) promote its children to top-level and (b) cascade-delete ONLY the deleted
    # parent's budget target — a promoted child keeps its own budget.
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()  # seed
    repo.update_category("groceries", "Groceries", "Living", "cart", parent="transport")
    budget = FakeBudgetRepo(budgets={"transport": {"target": 100}, "groceries": {"target": 50}})

    resp = handler.delete_category(
        _category_item_event("DELETE", cat_id="transport", body=None), repo, budget)

    assert resp["statusCode"] == 200
    items = repo._table.store[("CATEGORIES", "CATEGORIES")]["items"]
    assert "transport" not in items
    assert items["groceries"]["parent"] is None   # child promoted, not deleted
    assert budget.delete_calls == ["transport"]   # only the parent's budget cascaded


def test_create_whitespace_only_parent_400_repo_untouched(handler):
    # `_parse_parent` treats a blank/whitespace string as invalid, like a non-string.
    # "   " must 400 and never reach the repo (else the repo would validate a garbage id).
    repo = FakeCategoryRepo()
    resp = handler.create_category(
        _categories_event('{"name": "Parking", "bucket": "Living", "icon": "car", "parent": "   "}'),
        repo, FakeBudgetRepo())
    assert resp["statusCode"] == 400
    assert repo.create_calls == []


def test_update_whitespace_only_parent_400_repo_untouched(handler):
    # Same guard on update — a whitespace parent is rejected before the repo, so it
    # can neither re-parent to nor clobber a link with a blank id.
    repo = FakeCategoryRepo()
    resp = handler.update_category(
        _category_item_event("PATCH", body='{"name": "Coffee", "bucket": "Living", "parent": "\\t"}'),
        repo, FakeBudgetRepo())
    assert resp["statusCode"] == 400
    assert repo.update_parents == []  # never reached the repo


def test_create_parent_is_trimmed_before_storage(handler):
    # A padded parent id is trimmed to its bare slug before it reaches the repo, so a
    # copy-paste with stray spaces still matches the real parent id.
    repo = FakeCategoryRepo()
    resp = handler.create_category(
        _categories_event('{"name": "Parking", "bucket": "Living", "icon": "car", "parent": "  transport  "}'),
        repo, FakeBudgetRepo())
    assert resp["statusCode"] == 201
    assert repo.create_parents == ["transport"]  # trimmed, not "  transport  "


# --- WHIT-223 QA gap tests (adversarial edges beyond the implementer's set) ---
# Author: QA. Cover the depth cap's edges the diff's own tests leave open:
#   [gap1] the depth message riding the existing 400 mapping (end-to-end, real repo);
#   [gap2/3] a within-cap re-parent under a parent that ALREADY has a deep sibling;
#   [gap5] detach-then-reattach within the cap;
#   [gap7] the same-parent no-op re-parent (no double-count on legal chains; and the
#          adversarial contrast on a grandfathered over-deep chain);
#   [gap8] a LONG corrupt down-cycle still terminating with a decision.
# Reuses _repo_with_fake_table / FakeCategoryRepo / FakeBudgetRepo / event builders.


def test_handler_create_depth_breach_surfaces_plain_message_400(handler):
    # [WHIT-223 gap1] A real depth breach through the CREATE handler returns 400 with the
    # plain user-facing message in the body. The suite's existing handler tests only prove
    # a generic InvalidCategoryParentError -> 400 (message "bad parent"); this drives the
    # REAL repo so the specific "5 levels" message is what rides `str(e)`.
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()  # seed; transport is a top-level Living category (level 1)
    repo.create_category("l2", "L2", "Living", "car", parent="transport")
    repo.create_category("l3", "L3", "Living", "car", parent="l2")
    repo.create_category("l4", "L4", "Living", "car", parent="l3")
    repo.create_category("l5", "L5", "Living", "car", parent="l4")  # level 5

    resp = handler.create_category(
        _categories_event('{"name": "L6", "bucket": "Living", "icon": "car", "parent": "l5"}'),
        repo, FakeBudgetRepo())

    assert resp["statusCode"] == 400
    assert "5 levels" in json.loads(resp["body"])["error"]
    assert "l6" not in repo._table.store[("CATEGORIES", "CATEGORIES")]["items"]


def test_handler_update_depth_breach_surfaces_plain_message_400(handler):
    # [WHIT-223 gap1] Same, through the UPDATE (re-parent) handler: a re-parent that would
    # exceed the cap comes back 400 with the plain message, and the stored link is untouched.
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()
    repo.create_category("l2", "L2", "Living", "car", parent="transport")
    repo.create_category("l3", "L3", "Living", "car", parent="l2")
    repo.create_category("l4", "L4", "Living", "car", parent="l3")  # level 4
    repo.create_category("gsub", "GSub", "Living", "cart", parent="groceries")  # groceries 2 tall

    resp = handler.update_category(
        _category_item_event("PATCH", cat_id="groceries",
            body='{"name": "Groceries", "bucket": "Living", "icon": "cart", "parent": "l4"}'),
        repo, FakeBudgetRepo())

    assert resp["statusCode"] == 400  # 4 + 2 = 6 rejected
    assert "5 levels" in json.loads(resp["body"])["error"]
    assert repo._table.store[("CATEGORIES", "CATEGORIES")]["items"]["groceries"].get("parent") is None


def test_repo_reparent_within_cap_ignores_deep_sibling_and_stores_parent(handler):
    # [WHIT-223 gap2/gap3] The cap is measured PER moved subtree. A parent that already has
    # a deep child must not push a DIFFERENT, shallow node over the cap. mid (level 2) already
    # carries a chain down to level 5; moving a separate shallow leaf under mid lands it at
    # level 3 and is stored. Fail-on-revert of any "sum the parent's whole subtree" mistake:
    # such a check would read mid's 4-tall subtree and wrongly reject (2 + 4 = 6).
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()  # transport level 1
    repo.create_category("mid", "Mid", "Living", "car", parent="transport")  # level 2
    repo.create_category("s3", "S3", "Living", "car", parent="mid")
    repo.create_category("s4", "S4", "Living", "car", parent="s3")
    repo.create_category("s5", "S5", "Living", "car", parent="s4")  # existing deepest, level 5
    repo.create_category("leaf", "Leaf", "Living", "car")           # separate top-level, 1 tall

    updated = repo.update_category("leaf", "Leaf", "Living", "car", parent="mid")  # 2 + 1 = 3

    assert updated["parent"] == "mid"
    assert repo._table.store[("CATEGORIES", "CATEGORIES")]["items"]["leaf"]["parent"] == "mid"


def test_repo_detach_then_reattach_within_cap(handler):
    # [WHIT-223 gap5] Detach a deep node to top-level (always allowed, skips the depth check),
    # then re-attach it within the cap -> succeeds and stores the new parent.
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()
    repo.create_category("l2", "L2", "Living", "car", parent="transport")
    repo.create_category("l3", "L3", "Living", "car", parent="l2")  # level 3

    repo.update_category("l3", "L3", "Living", "car", parent=None)  # detach
    assert repo._table.store[("CATEGORIES", "CATEGORIES")]["items"]["l3"]["parent"] is None

    reattached = repo.update_category("l3", "L3", "Living", "cart", parent="groceries")  # level 2
    assert reattached["parent"] == "groceries"
    assert repo._table.store[("CATEGORIES", "CATEGORIES")]["items"]["l3"]["parent"] == "groceries"


def test_repo_noop_reparent_legal_chain_not_double_counted(handler):
    # [WHIT-223 gap7] Re-parenting a node to the parent it ALREADY has must not double-count.
    # validate_category_depth runs on the pre-write items, where cat_id is still a child of
    # parent_id — but ancestor_depth walks UP from the parent and subtree_height walks DOWN
    # from cat_id, so they never overlap. A legal boundary chain's same-parent re-parent is
    # therefore allowed (4 + 1 = 5), not spuriously rejected.
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()
    repo.create_category("l2", "L2", "Living", "car", parent="transport")
    repo.create_category("l3", "L3", "Living", "car", parent="l2")
    repo.create_category("l4", "L4", "Living", "car", parent="l3")
    repo.create_category("l5", "L5", "Living", "car", parent="l4")  # legal level-5 leaf

    updated = repo.update_category("l5", "L5", "Living", "car", parent="l4")  # same parent, no-op

    assert updated["parent"] == "l4"
    assert repo._table.store[("CATEGORIES", "CATEGORIES")]["items"]["l5"]["parent"] == "l4"


def test_repo_noop_reparent_grandfathered_overdeep_is_allowed(handler):
    # A legacy chain deeper than the cap must stay editable even when the client RESUBMITS
    # the same, unchanged parent (not just when `parent` is omitted). A no-op re-parent adds
    # no depth, so validate_category_depth short-circuits it — upholding the grandfather
    # guarantee (Decision 2). Fail-on-revert: dropping the no-op guard reddens this with
    # "categories can be nested at most 5 levels deep".
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()
    items = repo._table.store[("CATEGORIES", "CATEGORIES")]["items"]
    prev = "transport"
    for i in range(2, 7):  # hand-build legacy levels 2..6, past the cap
        cid = f"g{i}"
        items[cid] = {"id": cid, "name": cid, "icon": "car", "color": "#fff",
                      "bucket": "Living", "parent": prev}
        prev = cid

    # g6 (level 6, legacy) re-submitted under its EXISTING parent g5 -> allowed (no-op, adds
    # no depth), and the link is preserved.
    updated = repo.update_category("g6", "G6 Renamed", "Living", "car", parent="g5")
    assert updated["parent"] == "g5"
    assert updated["name"] == "G6 Renamed"


def test_validate_depth_terminates_on_a_long_corrupt_cycle(handler):
    # [WHIT-223 gap8] A LONG corrupt down-cycle in the moved subtree must terminate (no hang,
    # no runaway) and still return a decision. validate_category_parent walks only UP from the
    # parent, so it never sees this down-cycle -> _subtree_height's `visited` guard is the only
    # thing that saves it. Fail-on-revert: dropping that guard hangs this test.
    import repository
    ring = {"top": {"id": "top", "bucket": "Living", "parent": None}}
    n = 300
    for i in range(n):
        cid = f"c{i}"
        ring[cid] = {"id": cid, "bucket": "Living", "parent": f"c{(i - 1) % n}"}  # c0<-c1<-...<-c0

    # Moving c0 (its "subtree" is the whole 300-node ring) under top must return a decision.
    with pytest.raises(repository.InvalidCategoryParentError):  # 1 + 300 > 5
        repository.validate_category_depth(ring, "c0", "top")


# --- permanent chart colour slots (colorSlot) --------------------------------
#
# A category's chart colour is a STORED integer, assigned once and never recomputed, so
# adding or deleting a category cannot repaint any other one. These tests pin that promise,
# the one-time backfill that gives existing stores their slots, and — most importantly —
# that the backfill can NEVER fail a read (seven handler routes call list_categories).

# The solved slot table (see repository_category.SEED_CATEGORIES): each built-in in its own hue family, spread around the ramp.
SEED_SLOTS = {
    "eatingout": 0, "travel": 1, "fitness": 6, "gifts": 7, "health": 8, "coffee": 9,
    "utilities": 10, "groceries": 11, "shopping": 13, "transport": 15, "phonenet": 16,
    "pets": 17, "subs": 18,
}
_CFG = ("CATEGORIES", "CATEGORIES")
def _schema():
    """The CURRENT marker value, read from the module rather than written out — a settled
    store carries it, so a future bump needs no sweep through this file. A function, not a
    constant: the `handler` fixture is what puts shared/ on the path."""
    import repository_category
    return repository_category._COLOR_SLOT_SCHEMA


def _throttle():
    err = ClientError()
    # handle_database_error reads Message too, so a realistic fake carries both.
    err.response = {"Error": {"Code": "ProvisionedThroughputExceededException",
                              "Message": "rate exceeded"}}
    return err


def _legacy_store(repo, repository, *, extra=None, drop_marker=True):
    """A store as it existed BEFORE colorSlot: seeded rows with no slot, no marker."""
    items = {}
    for cat_id, cat in repository.SEED_CATEGORIES.items():
        items[cat_id] = {k: v for k, v in cat.items() if k != "colorSlot"}
    if extra:
        items.update(copy.deepcopy(extra))
    item = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": items, "version": Decimal(1)}
    if not drop_marker:
        item["colorSlotSchema"] = 1
    repo._table.store[_CFG] = item
    return item


def test_seed_slots_are_the_solved_table(handler):
    import repository
    slots = {cid: cat["colorSlot"] for cid, cat in repository.SEED_CATEGORIES.items()}
    assert slots == SEED_SLOTS
    assert len(set(slots.values())) == 13          # distinct: no two built-ins share a colour
    assert all(0 <= s < 20 for s in slots.values())


def test_fresh_store_is_born_migrated_and_never_backfills(handler):
    repository, repo = _repo_with_fake_table(handler)
    rows = repo.list_categories()
    assert {r["id"]: r["colorSlot"] for r in rows} == SEED_SLOTS
    # The seed put_item carries the marker, so a brand-new store performs NO backfill write.
    assert repo._table.update_calls == []
    assert repo._table.store[_CFG]["version"] == 1


def test_legacy_store_backfills_once_to_the_solved_table(handler):
    repository, repo = _repo_with_fake_table(handler)
    _legacy_store(repo, repository)

    rows = repo.list_categories()

    # Every built-in lands on its designated slot — an existing user's colours are the ones
    # that were solved for, not whatever a lowest-free walk would have handed out.
    assert {r["id"]: r["colorSlot"] for r in rows} == SEED_SLOTS
    stored = repo._table.store[_CFG]
    assert {cid: c["colorSlot"] for cid, c in stored["items"].items()} == SEED_SLOTS
    assert stored["colorSlotSchema"] == _schema() and stored["version"] == 2
    assert len(repo._table.update_calls) == 1


def test_migrated_store_performs_zero_writes_on_every_later_read(handler):
    repository, repo = _repo_with_fake_table(handler)
    _legacy_store(repo, repository)
    repo.list_categories()                      # migrates
    repo._table.update_calls.clear()

    for _ in range(5):
        rows = repo.list_categories()

    # "One-time migration, not work on every load" — the load-bearing guarantee.
    assert repo._table.update_calls == []
    assert {r["id"]: r["colorSlot"] for r in rows} == SEED_SLOTS


def test_empty_plan_still_stamps_the_marker_without_touching_items(handler):
    repository, repo = _repo_with_fake_table(handler)
    _legacy_store(repo, repository, drop_marker=True)
    # Everything already validly slotted, but the marker is missing.
    for cat_id, cat in repo._table.store[_CFG]["items"].items():
        cat["colorSlot"] = SEED_SLOTS[cat_id]

    repo.list_categories()

    expr, names, _ = repo._table.update_calls[0]
    # Declaring #items with nothing to write would be a DynamoDB ValidationException.
    assert set(names) == {"#v", "#schema"}
    assert "#items" not in expr
    repo._table.update_calls.clear()
    repo.list_categories()
    assert repo._table.update_calls == []       # and it never re-plans again


def test_store_with_every_category_deleted_still_stops_replanning(handler):
    repository, repo = _repo_with_fake_table(handler)
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES",
                               "items": {}, "version": 1}

    assert repo.list_categories() == []
    assert len(repo._table.update_calls) == 1   # marker written
    repo._table.update_calls.clear()
    assert repo.list_categories() == []
    assert repo._table.update_calls == []       # not once per read, forever


def test_corrupt_slots_are_reassigned_not_trusted(handler):
    repository, repo = _repo_with_fake_table(handler)
    bad = {
        "s": {"id": "s", "name": "S", "icon": "i", "color": "#fff", "bucket": "Living", "colorSlot": "7"},
        "f": {"id": "f", "name": "F", "icon": "i", "color": "#fff", "bucket": "Living", "colorSlot": 7.5},
        "n": {"id": "n", "name": "N", "icon": "i", "color": "#fff", "bucket": "Living", "colorSlot": -5},
        "b": {"id": "b", "name": "B", "icon": "i", "color": "#fff", "bucket": "Living", "colorSlot": True},
        "o": {"id": "o", "name": "O", "icon": "i", "color": "#fff", "bucket": "Living", "colorSlot": 999},
    }
    _legacy_store(repo, repository, extra=bad)

    rows = {r["id"]: r["colorSlot"] for r in repo.list_categories()}

    for cat_id in bad:
        assert isinstance(rows[cat_id], int) and 0 <= rows[cat_id] < 20
    assert len(set(rows.values())) == len(rows)          # still all distinct
    assert {k: rows[k] for k in SEED_SLOTS} == SEED_SLOTS   # built-ins unaffected


def test_already_slotted_rows_keep_their_slots_when_others_backfill(handler):
    repository, repo = _repo_with_fake_table(handler)
    _legacy_store(repo, repository)
    repo._table.store[_CFG]["items"]["coffee"]["colorSlot"] = 19   # deliberately not its seed slot

    rows = {r["id"]: r["colorSlot"] for r in repo.list_categories()}

    assert rows["coffee"] == 19                     # untouched: never repaint a stored slot
    _, names, _ = repo._table.update_calls[0]
    assert "coffee" not in names.values()           # and it isn't even in the write
    assert rows["eatingout"] == 0                   # the rest still land on their table


def test_read_fails_open_when_the_backfill_write_is_throttled(handler):
    """The blocker this design exists for: a failed backfill must NOT fail the read.

    list_categories is called by GET /categories, /breakdown, /budgets, /insights and more.
    A raise here would 500 or 409 a read that would otherwise have succeeded.
    """
    repository, repo = _repo_with_fake_table(handler)
    _legacy_store(repo, repository)
    repo._table.update_error = _throttle()

    rows = repo.list_categories()                   # must not raise

    # The response still carries the RIGHT slots, computed in memory.
    assert {r["id"]: r["colorSlot"] for r in rows} == SEED_SLOTS
    # Nothing was persisted, so a later request retries.
    assert "colorSlotSchema" not in repo._table.store[_CFG]


def test_read_fails_open_when_another_writer_wins_the_race(handler):
    repository, repo = _repo_with_fake_table(handler)
    _legacy_store(repo, repository)
    repo._table.update_error = _ccfe()

    rows = repo.list_categories()

    assert {r["id"]: r["colorSlot"] for r in rows} == SEED_SLOTS


def test_create_fails_closed_when_the_backfill_write_errors(handler):
    """The write path is the opposite policy: a real DB fault is a real failure."""
    repository, repo = _repo_with_fake_table(handler)
    _legacy_store(repo, repository)
    repo._table.update_error = _throttle()

    with pytest.raises(repository.DatabaseError):
        repo.create_category("wine", "Wine", "Lifestyle", "glass")


def test_create_takes_the_lowest_free_slot(handler):
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()                          # seed (slots 0,1,6,7,8,9,10,11,13,15,16,17,18)

    created = repo.create_category("wine", "Wine", "Lifestyle", "glass")

    assert created["colorSlot"] == 2                # lowest free under the solved table
    assert repo._table.store[_CFG]["items"]["wine"]["colorSlot"] == 2


def test_create_on_a_legacy_store_lands_on_the_first_attempt(handler):
    """The backfill runs BEFORE the retry loop. Inside it, it would bump the version between
    create's read and its conditional write and burn attempt 1 of 2 on every create."""
    repository, repo = _repo_with_fake_table(handler)
    _legacy_store(repo, repository)

    created = repo.create_category("wine", "Wine", "Lifestyle", "glass")

    assert created["colorSlot"] == 2
    # exactly two writes: the backfill, then the create. A third means create retried.
    assert len(repo._table.update_calls) == 2


def test_deleting_a_category_frees_its_slot_for_reuse(handler):
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()
    assert repository.SEED_CATEGORIES["gifts"]["colorSlot"] == 7

    repo.delete_category("gifts")
    created = repo.create_category("wine", "Wine", "Lifestyle", "glass")

    assert created["colorSlot"] == 2                # still the lowest free, not gifts' 7
    repo.delete_category("coffee")                  # frees slot 9
    assert repo.create_category("beer", "Beer", "Lifestyle", "glass")["colorSlot"] == 3


def test_adding_and_deleting_never_repaints_another_category(handler):
    """The card's whole promise, asserted end to end."""
    repository, repo = _repo_with_fake_table(handler)
    before = {r["id"]: r["colorSlot"] for r in repo.list_categories()}

    repo.create_category("wine", "Wine", "Lifestyle", "glass")
    after_add = {r["id"]: r["colorSlot"] for r in repo.list_categories()}
    assert {k: after_add[k] for k in before} == before

    repo.delete_category("wine")
    after_delete = {r["id"]: r["colorSlot"] for r in repo.list_categories()}
    assert after_delete == before


def test_plan_is_deterministic_regardless_of_map_order(handler):
    import repository
    items = {cid: {k: v for k, v in cat.items() if k != "colorSlot"}
             for cid, cat in repository.SEED_CATEGORIES.items()}
    reordered = {cid: items[cid] for cid in reversed(list(items))}

    # Both request paths compute the plan independently; if they could disagree, a deferred
    # write and the response it already returned would show different colours.
    assert repository.plan_color_slot_backfill(items) == repository.plan_color_slot_backfill(reordered)
    assert repository.plan_color_slot_backfill(items) == SEED_SLOTS


def test_least_held_color_slot_is_the_lowest_free_slot_below_saturation(handler):
    """While any slot is free, least-held IS lowest-free — a free slot has count 0 and always
    wins, so WHIT-404 changed nothing for a store under 20 categories."""
    import repository
    none_held = frozenset()
    assert repository.least_held_color_slot(Counter(), none_held) == 0
    assert repository.least_held_color_slot(Counter({0: 1, 1: 1, 2: 1}), none_held) == 3
    assert repository.least_held_color_slot(Counter({0: 1, 2: 1, 3: 1}), none_held) == 1  # delete freed 1
    # A deleted BUILT-IN's slot is reused immediately too — the non-seed preference decides
    # which colour to DOUBLE UP on, and that question does not exist while a slot is free.
    seeds_minus_eatingout = Counter({slot: 1 for slot in range(1, 20)})
    assert repository.least_held_color_slot(seeds_minus_eatingout, none_held) == 0
    # Junk outside the ramp cannot make a real slot look taken, and reading a missing slot
    # must not INSERT it (a plain dict here would raise instead).
    junk = Counter({99: 5, -1: 3})
    assert repository.least_held_color_slot(junk, none_held) == 0
    assert set(junk) == {99, -1}


def test_least_held_color_slot_spreads_repeats_instead_of_piling_on_one(handler):
    """WHIT-404: past 20 categories a duplicate is unavoidable, but it must not always be the
    SAME duplicate. Before this, every category past the 20th took slot 0."""
    import repository
    none_held = frozenset()
    full = Counter({slot: 1 for slot in range(20)})
    assert repository.least_held_color_slot(full, none_held) == 2       # lowest non-seed slot
    full[2] += 1
    assert repository.least_held_color_slot(full, none_held) == 3       # next non-seed, not 2 again
    # Saturated but uneven: the emptiest slot wins even though it is not the lowest. (A merely
    # FREE slot 7 would not discriminate — the old lowest-free walk answers 7 too.)
    uneven = Counter({slot: 2 for slot in range(20)})
    uneven[0] = 5
    uneven[7] = 1
    assert repository.least_held_color_slot(uneven, none_held) == 7


def test_least_held_color_slot_prefers_slots_no_builtin_owns(handler):
    """WHIT-404 option B: a repeat has to land somewhere, and doubling up on a colour only a
    custom category wears beats doubling up on Eating Out's. Derived from SEED_CATEGORIES, so
    it cannot drift if the seeds are retuned."""
    import repository
    import repository_category
    seed_slots = {int(cat["colorSlot"]) for cat in repository.SEED_CATEGORIES.values()}
    non_seed = repository_category._NON_SEED_COLOR_SLOTS
    assert non_seed == frozenset(range(20)) - seed_slots
    # slot 0 (Eating Out) and slot 2 (no built-in) both held once: the non-seed slot wins even
    # though 0 is the lower number.
    full = Counter({slot: 1 for slot in range(20)})
    assert repository.least_held_color_slot(full, frozenset()) == 2
    # ...but count still dominates preference: a seed slot held ONCE beats a non-seed held twice.
    full.update({slot: 1 for slot in sorted(non_seed)})
    assert repository.least_held_color_slot(full, frozenset()) == 0


def test_least_held_color_slot_treats_reserved_as_a_hard_exclusion(handler):
    """The blocker WHIT-404's first plan shipped: an owed slot is held by NOBODY, so counting
    it as merely +1 leaves it tied with a singly-held slot and the tie-break hands it over —
    permanently stealing the colour the backfill was about to give a built-in."""
    import repository
    # The owed slot must be a NON-SEED slot or this cannot discriminate: if it belonged to a
    # built-in, the non-seed preference would walk away from it anyway and the test would pass
    # against the weight design too. Slot 2 is free and owned by no built-in.
    counts = Counter({0: 1, 1: 1, **{slot: 1 for slot in range(3, 20)}})
    assert repository.least_held_color_slot(counts, frozenset()) == 2        # unreserved: takes it
    assert repository.least_held_color_slot(counts, frozenset({2})) == 3     # reserved: skips it
    # Every slot owed (an unmigrated store with >20 unslotted rows): something must be taken
    # back, but it must not be a built-in's designated slot. Slot 1 is travel's and free;
    # returning it would repaint travel permanently, which is the bug this branch exists for.
    assert repository.least_held_color_slot(Counter({0: 1}), frozenset(range(20))) == 2


def test_slot_survives_json_encoding_as_a_number(handler):
    """DynamoDB hands back Decimal; the client reads JSON. Pin the seam between the slices."""
    import repository
    from encoders import DecimalEncoder
    _, repo = _repo_with_fake_table(handler)
    repo.list_categories()
    created = repo.create_category("wine", "Wine", "Lifestyle", "glass")

    decoded = json.loads(json.dumps(created, cls=DecimalEncoder))

    assert decoded["colorSlot"] == 2
    # `type is int`, not isinstance: bool passes isinstance(int), and a Decimal would encode
    # to 2.0 (a float) — the POST body must match the int GET returns.
    assert type(decoded["colorSlot"]) is int


# --- colorSlot: the adversarial half -----------------------------------------


def _cat(cat_id, bucket="Living", **extra):
    return {"id": cat_id, "name": cat_id.title(), "icon": "tag",
            "color": "#ffffff", "bucket": bucket, **extra}


def test_read_fails_open_when_the_backfill_hits_a_network_error(handler):
    """A timeout is a BotoCoreError, NOT a ClientError. Catching only ClientError would let
    it escape and 500 every route that reads categories — the outage fail-open exists to
    prevent, and the likeliest transient fault in Lambda."""
    repository, repo = _repo_with_fake_table(handler)
    _legacy_store(repo, repository)

    class NetworkBlip(Exception):
        pass
    repo._table.update_error = NetworkBlip("connect timeout")

    rows = repo.list_categories()  # must not raise

    assert {r["id"]: r["colorSlot"] for r in rows} == SEED_SLOTS
    assert "colorSlotSchema" not in repo._table.store[_CFG]  # nothing persisted; retries later


def test_a_stored_row_without_an_id_field_does_not_break_the_read(handler):
    """list_categories fails OPEN on write faults, so it must not gain a way for malformed
    DATA to fail the read either — it is on the read path of every category-reading route."""
    repository, repo = _repo_with_fake_table(handler)
    _legacy_store(repo, repository)
    repo._table.store[_CFG]["items"]["orphan"] = {
        k: v for k, v in _cat("orphan").items() if k != "id"}

    assert len(repo.list_categories()) == 14


def test_a_config_item_without_a_version_does_not_break_the_read(handler):
    repository, repo = _repo_with_fake_table(handler)
    _legacy_store(repo, repository)
    del repo._table.store[_CFG]["version"]

    assert len(repo.list_categories()) == 13


def test_a_row_whose_id_disagrees_with_its_map_key_still_gets_its_slot(handler):
    """The plan and the write are both keyed by the MAP KEY; the response must be too, or a
    skewed row is stamped in the store but returned with a null slot — which the client would
    resolve to an undefined colour."""
    repository, repo = _repo_with_fake_table(handler)
    _legacy_store(repo, repository)
    repo._table.store[_CFG]["items"]["skew"] = _cat("skew-different")

    rows = {r["id"]: r["colorSlot"] for r in repo.list_categories()}

    assert rows["skew-different"] is not None


def test_a_custom_id_sorting_before_a_builtin_cannot_steal_its_slot(handler):
    """Pass 1 runs to completion over ALL missing ids before pass 2 starts. Collapse them
    into one alphabetical walk and "aaa" takes slot 0 — eatingout's designated hue."""
    repository, repo = _repo_with_fake_table(handler)
    _legacy_store(repo, repository, extra={"aaa": _cat("aaa"), "aab": _cat("aab")})

    rows = {r["id"]: r["colorSlot"] for r in repo.list_categories()}

    assert {k: rows[k] for k in SEED_SLOTS} == SEED_SLOTS
    assert rows["aaa"] == 2 and rows["aab"] == 3   # the first slots no built-in wants
    assert len(set(rows.values())) == len(rows)


def test_create_cannot_steal_a_slot_the_deferred_backfill_still_owes(handler):
    """The pre-loop backfill LOSES its race, so create runs against still-unslotted rows. It
    must reserve what the plan owes them, or it takes 0 (eatingout's colour) and the next
    read repaints one of them."""
    repository, repo = _repo_with_fake_table(handler)
    _legacy_store(repo, repository)
    repo._table.before_update.append(_bump_version)  # backfill write -> CCFE, silent no-op

    created = repo.create_category("wine", "Wine", "Lifestyle", "glass")

    assert created["colorSlot"] == 2                 # NOT 0
    rows = {r["id"]: r["colorSlot"] for r in repo.list_categories()}
    assert {k: rows[k] for k in SEED_SLOTS} == SEED_SLOTS
    assert len(set(rows.values())) == len(rows)


def test_two_creates_racing_never_land_on_the_same_slot(handler):
    """The slot is computed INSIDE the retry loop, so the loser re-reads and sees the
    winner's slot taken. Hoist it out of the loop and both creates land on 2."""
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()                           # migrated; lowest free = 2

    def concurrent_create(item):
        item["items"]["beer"] = _cat("beer", "Lifestyle", colorSlot=Decimal(2))
        item["version"] = item["version"] + 1
    repo._table.before_update.append(concurrent_create)

    created = repo.create_category("wine", "Wine", "Lifestyle", "glass")

    assert created["colorSlot"] == 3                 # not 2 — the winner holds that
    stored = repo._table.store[_CFG]["items"]
    assert stored["beer"]["colorSlot"] == 2 and stored["wine"]["colorSlot"] == 3


def test_past_twenty_categories_slots_stay_in_range(handler):
    """The ramp has 20 colours, so past 20 live categories distinctness is impossible. Pin
    what actually happens so the client can never index outside the ramp."""
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()                           # 13 seeds
    slots = [int(repo.create_category(f"x{n}", f"X{n}", "Lifestyle", "tag")["colorSlot"])
             for n in range(9)]                      # the 14th .. 22nd category

    assert all(0 <= s < 20 for s in slots)
    # WHIT-415 moved coffee off slot 4 onto 9, so the free list shifts but stays 7 long.
    assert slots[:7] == [2, 3, 4, 5, 12, 14, 19]     # every free slot, lowest first
    # WHIT-404: ramp full -> the repeat goes to the LEAST-held slot, preferring one no
    # built-in owns. Was [0, 0] — every category past the 20th piled onto Eating Out.
    assert slots[7:] == [2, 3]


def test_plan_past_twenty_unslotted_rows_stays_in_range(handler):
    import repository
    items = {f"c{n:02d}": _cat(f"c{n:02d}") for n in range(25)}

    plan = repository.plan_color_slot_backfill(items)

    assert len(plan) == 25
    assert all(0 <= s < 20 for s in plan.values())   # never an out-of-ramp index
    assert sorted(set(plan.values())) == list(range(20))


def test_colorslot_never_reaches_the_ai_model_input_hash(handler):
    """POST /insights/ai hashes model_input to decide cache-hit vs a PAID Anthropic re-run.
    If the projection ever stopped dropping this new field, every cached insight would bust
    once and every user would pay for a regeneration. Nothing else enforces it."""
    cats_without = [{"id": "coffee", "name": "Cafes", "bucket": "Lifestyle", "parent": None},
                    {"id": "rent", "name": "Rent", "bucket": "Living", "parent": None}]
    cats_with = [{**c, "colorSlot": 4} for c in cats_without]
    txns = [{"category": "coffee", "amount": -10, "status": "posted",
             "counts_to_budget": True, "date": "2026-06-01"}]

    rows_without = handler._window_category_spend(txns, cats_without)
    rows_with = handler._window_category_spend(txns, cats_with)

    assert rows_with == rows_without
    assert "colorSlot" not in json.dumps(rows_with, sort_keys=True)


def test_seed_slots_are_spread_across_the_colour_ramp(handler):
    """The property the seed table was solved for — and the one two reviewers misread.

    A slot is NOT a ramp position: the client resolves it through ASSIGNMENT_ORDER, so
    consecutive slots are deliberately far apart in hue. Measuring runs on the raw slot
    numbers is meaningless (they run 15,16,17,18 but resolve to ramp 13,14,16,18). This
    pins the real invariant: no more than 3 built-ins ever occupy neighbouring ramp entries.

    ASSIGNMENT_ORDER lives client-side (src/chartColors.ts, slice 2) and is READ from
    there rather than copied (WHIT-406): a hand-typed copy would keep measuring a
    permutation the app no longer ships, so regenerating it client-side would repaint
    every category with nothing going red. tests/shared/test_color_slot_ramp_drift.py
    guards the lengths against the server's slot range.
    """
    import repository
    assignment_order = client_assignment_order()
    assert sorted(assignment_order) == list(range(len(assignment_order)))  # a true permutation

    ramp = sorted(assignment_order[cat["colorSlot"]]
                  for cat in repository.SEED_CATEGORIES.values())
    assert len(set(ramp)) == 13                          # 13 distinct colours

    longest = run = 1
    for previous, current in zip(ramp, ramp[1:]):
        run = run + 1 if current == previous + 1 else 1
        longest = max(longest, run)
    assert longest == 3, f"longest neighbouring-ramp run is {longest}: {ramp}"


# =============================================================================
# WHIT-415 — the seed re-space as PROPERTIES, not slot numbers.
#
# Every colour-slot test above pins an integer. Re-shuffle the seed and they all just get
# retyped, and the INTENT is never checked — test_seed_slots_are_spread_across_the_colour_ramp
# ("longest run == 3") was true BEFORE this card and is true AFTER it, so it did not guard the
# fix at all. These compute the RESOLVED RAMP LAYOUT from repository.SEED_CATEGORIES and assert
# what the card actually promised, so a future bad re-space fails loudly instead of quietly.
# =============================================================================

# The client's slot -> ramp-position permutation (src/chartColors.ts ASSIGNMENT_ORDER). Nothing in
# a pytest process can see the TypeScript, so this is a hand copy — the WHIT-406 gap. It is guarded
# from the OTHER side by src/__tests__/seedSlotSync.logic.test.ts, which parses this module's seed
# out of the .py and checks the same run structure. Both must be edited to move a slot unnoticed.
_ASSIGNMENT_ORDER = [0, 10, 5, 15, 2, 7, 12, 17, 1, 3, 4, 6, 8, 9, 11, 13, 14, 16, 18, 19]


def _seed_ramp(repository) -> dict:
    """{built-in id -> the RAMP POSITION its stored slot resolves to on the client}."""
    return {cid: _ASSIGNMENT_ORDER[cat["colorSlot"]]
            for cid, cat in repository.SEED_CATEGORIES.items()}


def _neighbouring_runs(ramp: dict) -> list:
    """Ids sitting on NEIGHBOURING ramp entries, grouped, warm end first. Runs of 1 are dropped.
    This is the shape a user perceives: a run of N is N near-identical hues that read as one
    colour when they land next to each other in the ring."""
    ordered = sorted((position, cid) for cid, position in ramp.items())
    runs, current = [], [ordered[0]]
    for previous, entry in zip(ordered, ordered[1:]):
        if entry[0] == previous[0] + 1:
            current.append(entry)
        else:
            runs.append(current)
            current = [entry]
    runs.append(current)
    return [[cid for _, cid in run] for run in runs if len(run) > 1]


def test_no_builtin_trio_sits_on_the_warm_end_of_the_ramp(handler):
    """THE card: Eating Out / Health / Coffee resolved to ramp 0/1/2 and, as the top three by
    spend, painted as three near-identical salmons. Asserted as the property — not as
    "coffee's slot is 9", which the next re-shuffle would simply retype."""
    import repository
    ramp = _seed_ramp(repository)

    warm_runs = [run for run in _neighbouring_runs(ramp) if min(ramp[c] for c in run) <= 5]
    assert all(len(run) <= 2 for run in warm_runs), f"warm-end run of 3+: {warm_runs}"
    # the salmon end (ramp 0-2) holds at most a PAIR, and nothing may creep back into it
    assert sorted(c for c, p in ramp.items() if p <= 2) == ["eatingout", "health"]
    # and the pair the card named by name is broken apart
    assert abs(ramp["coffee"] - ramp["eatingout"]) > 1
    assert abs(ramp["coffee"] - ramp["health"]) > 1


def test_the_neighbouring_builtin_runs_are_exactly_these(handler):
    """WHICH built-ins touch, pinned by name. Re-space again and you must edit this on purpose.

    It also records, honestly, what the card did NOT fix: TWO trios survive — fitness/transport/
    phonenet (ramp 12/13/14) and pets/gifts/subs (16/17/18) — and 12->13->14 are the TIGHTEST
    steps in the whole ramp, tighter than the warm trio that was just removed. Same symptom,
    different hue family; out of the approved scope, so it is pinned rather than fixed.
    """
    import repository
    assert _neighbouring_runs(_seed_ramp(repository)) == [
        ["eatingout", "health"],
        ["coffee", "utilities"],
        ["shopping", "travel"],
        ["fitness", "transport", "phonenet"],
        ["pets", "gifts", "subs"],
    ]


def test_the_slots_new_categories_get_never_reuse_a_builtin_hue(handler):
    """The property behind `slots[:7] == [3, 4, 5, 10, 12, 14, 19]`: the free slots are free
    RAMP ENTRIES too, so the first seven categories a user creates each get a hue no built-in
    owns. A re-space that duplicated a seed slot, or moved one onto a slot the lowest-free walk
    hands out, would give a custom category a built-in's exact colour — invisible in a table of
    magic numbers, caught here."""
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()
    builtin_ramp = set(_seed_ramp(repository).values())

    created = [repo.create_category(f"c{n}", f"C{n}", "Lifestyle", "tag") for n in range(7)]
    custom_ramp = [_ASSIGNMENT_ORDER[c["colorSlot"]] for c in created]

    assert len(set(custom_ramp)) == 7                       # seven distinct hues
    assert set(custom_ramp).isdisjoint(builtin_ramp)        # none of them a built-in's colour
    # 13 built-ins + 7 customs = the whole ramp, exactly once each
    assert set(custom_ramp) | builtin_ramp == set(range(20))


def test_the_first_custom_category_stays_out_of_the_ramps_tightest_stretch(handler):
    """Re-spacing the seed changes which slot is lowest-free, so it silently changes the colour a
    user's FIRST custom category gets. That is the trap this test exists for.

    Moving BOTH coffee and utilities (the obvious re-space) pushed the lowest free slot to 3, which
    resolves to ramp 15 — the gap between Phone & Internet (14) and Pets (16), the two tightest
    steps in the ramp — so the first custom category joined a run of SEVEN. Moving coffee alone
    keeps it on ramp 5, in the widest-spaced stretch, with the longest run at FOUR
    (coffee/utilities/wine/groceries, every step wider than any pair this card removed).

    Fail-on-revert: move utilities to slot 2 as well and wine lands on ramp 15 in a run of 7.
    """
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()

    first = repo.create_category("wine", "Wine", "Lifestyle", "glass")

    ramp = _seed_ramp(repository)
    ramp["wine"] = _ASSIGNMENT_ORDER[first["colorSlot"]]
    assert ramp["wine"] == 5
    runs = _neighbouring_runs(ramp)
    assert max(len(run) for run in runs) == 4
    assert ["coffee", "utilities", "wine", "groceries"] in runs
    # the blue cluster — the tightest stretch — must not have grown
    assert ["fitness", "transport", "phonenet"] in runs


@pytest.mark.parametrize("builtin,slot", [("coffee", 9)])
def test_a_custom_category_squatting_on_a_new_seed_slot_is_never_evicted(handler, builtin, slot):
    """Slots 2 and 9 are the two the re-space newly claims. Slot 2 in particular is the one the
    OLD lowest-free walk handed to the first category a user ever created, so a store that was
    partially slotted under the old rules can arrive with a squatter sitting exactly there.

    The rule that must hold: a stored slot is PERMANENT (WHIT-405), so the squatter keeps it and
    the built-in gives way — never the reverse, and never a shared colour.
    """
    repository, repo = _repo_with_fake_table(handler)
    _legacy_store(repo, repository, extra={"wine": _cat("wine", colorSlot=Decimal(slot))})

    rows = {r["id"]: r["colorSlot"] for r in repo.list_categories()}

    assert rows["wine"] == slot                      # the squatter is never repainted
    assert rows[builtin] != slot                     # the built-in gives way
    assert len(set(rows.values())) == len(rows)      # and nobody ends up sharing a colour
    # every OTHER built-in still lands on its solved slot
    assert {k: v for k, v in rows.items() if k in SEED_SLOTS and k != builtin} == \
           {k: v for k, v in SEED_SLOTS.items() if k != builtin}
    # The consequence worth knowing: the evicted built-in takes the lowest free slot, which
    # resolves to ramp 5 — so a squatter turns Coffee from an amber into an olive. Acceptable
    # (permanence beats hue fidelity), but not silent. Coffee's slot 9 is the ONLY slot this card
    # newly claims, so it is the only one a legacy squatter can now contest.
    assert _ASSIGNMENT_ORDER[rows[builtin]] == 5

# ---- WHIT-405: the backfill write is chunked so it can never exceed DynamoDB's 4KB cap ------

_SLOT = "colorSlot"
# The last clause count that fits DynamoDB's 4KB UpdateExpression cap: 129 clauses = 4070
# bytes, 130 = 4103. Any plan above this could not be written at all before the chunk cap.
_LAST_UNCHUNKED_CLAUSE_COUNT = 129

def _unslotted_store(repo, repository, count):
    """A legacy store with `count` EXTRA unslotted custom categories on top of the seeds."""
    extra = {f"cat{index:04d}": {"id": f"cat{index:04d}", "name": f"Cat {index}",
                                 "icon": "tag", "color": "#888888",
                                 "bucket": "Lifestyle", "parent": None}
             for index in range(count)}
    return _legacy_store(repo, repository, extra=extra)


def _drain(repo, limit=20):
    """Read until the backfill stops writing. Returns the number of write attempts."""
    for _ in range(limit):
        before = len(repo._table.update_calls)
        repo.list_categories()
        if len(repo._table.update_calls) == before:
            return before
    raise AssertionError(f"backfill did not converge within {limit} reads")


def test_a_backfill_expression_never_exceeds_dynamodbs_4kb_limit(handler):
    """The structural guard. Unchunked, 200 categories build a ~6KB expression that the real
    service rejects — and FakeTable now rejects it too, so deleting the cap reddens here."""
    repository, repo = _repo_with_fake_table(handler)
    _unslotted_store(repo, repository, 200)

    repo.list_categories()

    expression = repo._table.update_calls[0][0]
    assert len(expression.encode()) <= _MAX_UPDATE_EXPRESSION_BYTES
    # Well under, not just under: the cap exists to leave headroom, not to sit on the line.
    assert len(expression.encode()) < _MAX_UPDATE_EXPRESSION_BYTES // 2


def test_a_read_mid_drain_still_returns_every_category_fully_slotted(handler):
    """The user-visible guarantee: colours are right immediately, the database catches up
    behind. The response applies the WHOLE plan even though one chunk was persisted."""
    repository, repo = _repo_with_fake_table(handler)
    _unslotted_store(repo, repository, 200)

    rows = repo.list_categories()               # persists 50, returns all 213

    assert len(rows) == 213
    assert all(0 <= row["colorSlot"] < 20 for row in rows)
    # only the first chunk reached storage
    persisted = [cat for cat in repo._table.store[_CFG]["items"].values() if "colorSlot" in cat]
    assert len(persisted) == 50


def test_create_survives_a_backfill_too_big_for_one_write(handler):
    """The severity test — this is the production 500 the card describes. Unchunked, the
    pre-loop backfill runs strict=True against a 213-row plan, the expression is rejected,
    and POST /categories 500s forever."""
    repository, repo = _repo_with_fake_table(handler)
    _unslotted_store(repo, repository, 200)

    created = repo.create_category("wine", "Wine", "Lifestyle", "glass")

    # Not raising IS the assertion — on the unchunked code this call goes through
    # handle_database_error and raises DatabaseError, which the handler does not catch.
    # Slot 7 because the ramp is saturated past 20 live categories, so a duplicate is
    # unavoidable, and after chunk 1 the backfill has itself SPREAD its overflow (WHIT-428),
    # leaving the held counts uneven — so the genuinely least-held slot is 7, not the lowest
    # non-seed one. It was 2 while the backfill piled every overflow onto slot 0. The
    # non-collision property is pinned by
    # test_create_cannot_steal_a_slot_the_deferred_backfill_still_owes.
    assert created["colorSlot"] == 7


def test_a_throttled_chunk_leaves_earlier_chunks_intact_and_recovers(handler):
    """Fail-open has to survive PART-WAY through a drain: the throttle lands after chunk 1,
    so the rows already stamped must stay stamped, the marker must stay absent, and once the
    throttle clears a later read must finish the job."""
    repository, repo = _repo_with_fake_table(handler)
    _unslotted_store(repo, repository, 200)

    repo.list_categories()                       # chunk 1 lands
    persisted = {cid: cat["colorSlot"]
                 for cid, cat in repo._table.store[_CFG]["items"].items() if "colorSlot" in cat}
    assert len(persisted) == 50

    repo._table.update_error = _throttle()
    rows = repo.list_categories()                # chunk 2 is throttled — must not raise

    assert len(rows) == 213                      # response is still complete and correct
    assert all(0 <= row["colorSlot"] < 20 for row in rows)
    assert "colorSlotSchema" not in repo._table.store[_CFG]
    # the throttled write changed nothing — chunk 1's rows are untouched
    assert {cid: cat["colorSlot"]
            for cid, cat in repo._table.store[_CFG]["items"].items()
            if "colorSlot" in cat} == persisted

    repo._table.update_error = None
    _drain(repo)
    assert repo._table.store[_CFG]["colorSlotSchema"] == _schema()


def test_a_delete_between_chunks_still_lands_on_the_planners_fixed_point(handler):
    """A category removed mid-drain must leave every survivor stamped, on exactly the
    slots a fresh plan over the surviving rows would assign."""
    repository, repo = _repo_with_fake_table(handler)
    _unslotted_store(repo, repository, 200)

    repo.list_categories()                       # chunk 1
    repo.delete_category("cat0150")              # still unslotted, in a later chunk
    _drain(repo)

    stored = repo._table.store[_CFG]["items"]
    assert "cat0150" not in stored
    assert all("colorSlot" in cat for cat in stored.values())
    expected = repository.plan_color_slot_backfill(
        {cid: {k: v for k, v in cat.items() if k != "colorSlot"} for cid, cat in stored.items()}
    )
    assert {cid: int(cat["colorSlot"]) for cid, cat in stored.items()} == \
        {cid: int(slot) for cid, slot in expected.items()}


# ---- WHIT-405 [A1]-[A10]: randomised and boundary coverage of the chunked drain -------------
# The tests above cover the drain on hand-built stores. These cover it on GENERATED ones, on
# the exact chunk boundaries, and while another write lands mid-drain. [A1] is the one that
# catches a break the hand-built tests miss entirely: the equivalence argument rests on the
# chunk being an ALPHABETICAL prefix, so reversing the sort order diverges only on stores the
# generator produces. Expected values always come from the real exported planner — nothing is
# re-implemented here, so these cannot catch a planner bug; [A9] is the absolute pin for that.

def _exactly_unslotted(repo, count, *, version=1):
    """A store whose plan size is EXACTLY `count` — no seeds, so nothing else is unslotted.
    Lets a test sit precisely on a chunk boundary."""
    items = {f"c{index:04d}": {"id": f"c{index:04d}", "name": f"C{index}", "icon": "tag",
                               "color": "#888888", "bucket": "Lifestyle", "parent": None}
             for index in range(count)}
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES",
                               "items": items, "version": Decimal(version)}
    return repo._table.store[_CFG]


def _random_legacy_store(repository, rng):
    """A plausible legacy store: some built-ins deleted, some already slotted (not always on
    their designated slot), plus 0-260 custom rows, some slotted, some CORRUPT. Custom ids are
    random lowercase words so the built-ins land at random positions in the alphabetical
    chunk order — the one thing the committed 'cat0000..cat0199' shape never varies."""
    items = {}
    for cat_id, seed in repository.SEED_CATEGORIES.items():
        roll = rng.random()
        if roll < 0.25:
            continue                                     # built-in deleted before the backfill
        row = {k: v for k, v in seed.items() if k != _SLOT}
        if roll < 0.45:
            row[_SLOT] = Decimal(rng.randrange(20))      # already slotted, maybe not its own
        items[seed["id"]] = row
    for _ in range(rng.randrange(0, 260)):
        cat_id = "".join(rng.choice("abcdefghijklmnopqrstuvwxyz") for _ in range(6))
        if cat_id in repository.SEED_CATEGORIES:
            continue
        row = {"id": cat_id, "name": cat_id, "icon": "tag", "color": "#888888",
               "bucket": "Lifestyle", "parent": None}
        roll = rng.random()
        if roll < 0.15:
            row[_SLOT] = Decimal(rng.randrange(20))
        elif roll < 0.22:
            row[_SLOT] = rng.choice(["7", 7.5, -1, 99, True])   # corrupt -> must be reassigned
        items[cat_id] = row
    return items


# 250 randomised stores, fixed seed: deterministic, and wide enough that many trials exceed
# the clause count where an unchunked expression is rejected outright.
_PROPERTY_TRIALS = 250
_PROPERTY_SEED = 405


def test_a_chunked_drain_lands_exactly_where_one_unchunked_write_would_have(handler):
    # WHIT-405 — [A1] chunking is equivalent to one shot, over randomised stores.
    # The committed convergence test pins a SINGLE store shape. The equivalence argument in
    # _write_color_slots' docstring ("persisting an alphabetical prefix is a fixed point of
    # the planner") is subtle and load-bearing, and nothing in the suite exercises it against
    # varied shapes: built-ins scattered through the chunk order, pre-slotted rows, corrupt
    # slots, and saturation past 20. Expected values come from the REAL exported planner
    # (repository.plan_color_slot_backfill) applied once to the original store — never
    # re-implemented here.
    import random
    import repository_category
    repository, _ = _repo_with_fake_table(handler)
    rng = random.Random(_PROPERTY_SEED)
    chunk = repository_category._COLOR_SLOT_WRITE_CHUNK
    saw_over_the_unchunked_limit = 0

    for trial in range(_PROPERTY_TRIALS):
        _, repo = _repo_with_fake_table(handler)
        original = _random_legacy_store(repository, rng)
        repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES",
                                   "items": copy.deepcopy(original), "version": Decimal(1)}
        one_shot = repository.plan_color_slot_backfill(copy.deepcopy(original))
        if len(one_shot) > _LAST_UNCHUNKED_CLAUSE_COUNT:
            saw_over_the_unchunked_limit += 1
        # What single unbounded writes would have left in the table. Since WHIT-428 that is
        # TWO stages composed: the backfill, then the repaint of its result — 6 of these 250
        # stores are still piled after the backfill and need both. The expectation is built
        # from the two EXPORTED planners applied one-shot; deriving it by looping
        # plan_color_slot_stage would compare the code to itself and would pass even on a
        # planner that never converges.
        settled_store = {cid: ({**cat, _SLOT: Decimal(one_shot[cid])} if cid in one_shot
                               else cat)
                         for cid, cat in copy.deepcopy(original).items()}
        repaint = repository.plan_color_slot_repaint(settled_store)
        expected = {cid: int(repaint[cid]) if cid in repaint else int(cat[_SLOT])
                    for cid, cat in settled_store.items()}

        writes = _drain(repo, limit=30)

        stored = repo._table.store[_CFG]["items"]
        assert {cid: int(cat[_SLOT]) for cid, cat in stored.items()} == expected, \
            f"trial {trial}: chunked drain diverged from the one-shot plan"
        # Bounded, and never more writes than chunks: no read may re-plan work already done.
        # A repaint stage costs its own chunks on top of the backfill's.
        expected_writes = max(1, -(-len(one_shot) // chunk))
        if repaint:
            expected_writes += max(1, -(-len(repaint) // chunk))
        assert writes == expected_writes, f"trial {trial}: {writes} writes"
        assert repo._table.store[_CFG]["colorSlotSchema"] == _schema(), f"trial {trial}: unmarked"

    # Guard the guard: if the generator ever stopped producing stores past the point an
    # unchunked expression is rejected, this test would quietly stop testing the fix.
    assert saw_over_the_unchunked_limit >= 20, saw_over_the_unchunked_limit


def test_a_marker_is_never_present_while_a_row_is_still_unslotted(handler):
    # WHIT-405 — [A2] the marker means "every row is stamped", checked after EVERY write of
    # every randomised drain, not just the first chunk of one store. This is the invariant
    # `drained` exists to hold; the committed test checks it at one point of one store.
    import random
    repository, _ = _repo_with_fake_table(handler)
    rng = random.Random(_PROPERTY_SEED + 1)

    for trial in range(60):
        _, repo = _repo_with_fake_table(handler)
        repo._table.store[_CFG] = {
            "pk": "CATEGORIES", "sk": "CATEGORIES",
            "items": _random_legacy_store(repository, rng), "version": Decimal(1)}

        for _ in range(30):
            before = len(repo._table.update_calls)
            repo.list_categories()
            config = repo._table.store[_CFG]
            if "colorSlotSchema" in config:
                # Marker present -> BOTH real planners must find nothing left to do. Since
                # WHIT-428 the marker means more than "every row is stamped": it also means
                # the ramp is level. Without the repaint half, a store stamped on the
                # backfill's last chunk would strand a row on a shared colour forever.
                assert repository.plan_color_slot_backfill(config["items"]) == {}, \
                    f"trial {trial}: marker stamped with rows still unslotted"
                assert repository.plan_color_slot_repaint(config["items"]) == {}, \
                    f"trial {trial}: marker stamped with the ramp still piled"
            if len(repo._table.update_calls) == before:
                break
        else:
            raise AssertionError(f"trial {trial}: backfill did not converge")
        assert "colorSlotSchema" in repo._table.store[_CFG]


@pytest.mark.parametrize("unslotted,expected_writes", [
    (1, 1),        # smallest non-empty plan
    (49, 1),       # one under the chunk
    (50, 1),       # EXACTLY the chunk: must drain and stamp in a single write, not two
    (51, 2),       # one over: a 50 chunk plus a 1 remainder
    (100, 2),      # exact multiple: no empty third write
    (129, 3),      # the last plan an unchunked expression could still have written
    (130, 3),      # the first plan an unchunked expression could NOT (4103 bytes) — the card
    (213, 5),
])
def test_a_drain_takes_exactly_one_write_per_chunk(handler, unslotted, expected_writes):
    # WHIT-405 — [A3] chunk boundaries, including the 129/130 point the card names.
    # An off-by-one in `chunk`/`drained` shows up here as a wrong write count or a store that
    # keeps writing forever; the committed suite only ever tests 213.
    repository, repo = _repo_with_fake_table(handler)
    _exactly_unslotted(repo, unslotted)
    one_shot = repository.plan_color_slot_backfill(
        copy.deepcopy(repo._table.store[_CFG]["items"]))
    assert len(one_shot) == unslotted            # the fixture really does sit on the boundary

    writes = _drain(repo)

    assert writes == expected_writes
    stored = repo._table.store[_CFG]
    assert {cid: int(c[_SLOT]) for cid, c in stored["items"].items()} == \
        {cid: int(s) for cid, s in one_shot.items()}
    assert stored["colorSlotSchema"] == _schema()
    # ...and a fully drained store is back to one get_item per read, forever.
    repo._table.update_calls.clear()
    repo.list_categories()
    repo.list_categories()
    assert repo._table.update_calls == []


def test_a_create_between_chunks_keeps_its_slot_and_the_drain_still_finishes(handler):
    # WHIT-405 — [A4] only a DELETE between chunks is pinned. A create is the write that
    # actually adds a row the later chunks have never planned for, and it runs its own
    # strict=True backfill first — so it both consumes a chunk and inserts a row.
    repository, repo = _repo_with_fake_table(handler)
    _unslotted_store(repo, repository, 200)

    repo.list_categories()                                   # chunk 1
    after_chunk_one = {cid: int(cat[_SLOT])
                       for cid, cat in repo._table.store[_CFG]["items"].items() if _SLOT in cat}
    created = repo.create_category("wine", "Wine", "Lifestyle", "glass")
    _drain(repo)

    stored = repo._table.store[_CFG]["items"]
    # The created row keeps the slot the POST already told the client about — a later chunk
    # must never repaint a category that was already handed a colour.
    assert int(stored["wine"][_SLOT]) == created[_SLOT]
    assert all(_SLOT in cat for cat in stored.values()), "a row was left permanently unslotted"
    assert repo._table.store[_CFG]["colorSlotSchema"] == _schema()
    # WHIT-428 replaced a "re-plan the final store and compare" assertion here. It could not
    # survive, and NOT for a fixture reason: `wine`'s slot counts towards the least-held rule
    # from the moment it is created, so rows stamped in chunk 1 never saw it while a fresh
    # whole-store plan does — ~110 rows legitimately shift by one. The drain is a fixed point
    # under PREFIX PERSISTENCE, not under INSERTION. These three are what still bind, and (a)
    # is the stronger user-visible claim: a colour you have already been shown never changes.
    assert {cid: int(stored[cid][_SLOT]) for cid in after_chunk_one} == after_chunk_one
    assert {cid: int(stored[cid][_SLOT]) for cid in SEED_SLOTS} == SEED_SLOTS
    holders = _slot_histogram(repo)
    assert max(holders.values()) - min(holders.values()) <= 1


def test_a_create_mid_drain_spends_one_backfill_write_and_one_create_write(handler):
    # WHIT-405 — [A5] the retry budget. create_category runs the backfill BEFORE its 2-attempt
    # loop precisely so the version bump can't burn attempt 1. Now that the backfill takes
    # several bumps to finish, pin that a create still costs exactly one backfill write plus
    # one create write — moving the backfill inside the loop would show up as 3+.
    repository, repo = _repo_with_fake_table(handler)
    _unslotted_store(repo, repository, 200)
    repo.list_categories()                                   # leave the store mid-drain
    repo._table.update_calls.clear()

    repo.create_category("wine", "Wine", "Lifestyle", "glass")

    assert len(repo._table.update_calls) == 2
    slot_writes = [names for _e, names, _v in repo._table.update_calls if "#slot" in names]
    assert len(slot_writes) == 1


def test_a_create_mid_drain_still_survives_one_concurrent_version_bump(handler):
    # WHIT-405 — [A6] the second half of the budget: attempt 2 must still be available. A
    # concurrent writer bumps the version between the create's read and its write; the create
    # has to retry and succeed, mid-drain, not 409.
    repository, repo = _repo_with_fake_table(handler)
    _unslotted_store(repo, repository, 200)
    repo.list_categories()                                   # mid-drain
    # Skip the create's own backfill write, then race its first create attempt.
    repo._table.before_update = [lambda item: None, _bump_version]

    created = repo.create_category("wine", "Wine", "Lifestyle", "glass")

    assert created["id"] == "wine"
    assert "wine" in repo._table.store[_CFG]["items"]


def test_update_and_delete_mid_drain_succeed_on_their_first_attempt(handler):
    # WHIT-405 — [A7] update/delete never run the backfill, so a mid-drain store must not cost
    # them a retry. If either ever started migrating inline, its own version bump would
    # guarantee a CCFE and halve its budget — this pins one update_item call each.
    repository, repo = _repo_with_fake_table(handler)
    _unslotted_store(repo, repository, 200)
    repo.list_categories()                                   # mid-drain, marker absent
    assert "colorSlotSchema" not in repo._table.store[_CFG]
    repo._table.update_calls.clear()

    repo.update_category("coffee", "Cafes", "Lifestyle", "coffee")
    assert len(repo._table.update_calls) == 1
    repo._table.update_calls.clear()

    repo.delete_category("cat0100")
    assert len(repo._table.update_calls) == 1
    assert repo._table.store[_CFG]["items"]["coffee"]["name"] == "Cafes"
    assert "cat0100" not in repo._table.store[_CFG]["items"]


def test_rows_already_holding_a_valid_slot_never_move_during_a_chunked_drain(handler):
    # WHIT-405 — [A8] "adding a category cannot repaint any other" has to survive the drain.
    # These five sit on deliberately non-designated slots, so a chunk that re-derived them
    # instead of leaving them alone would change their colour.
    repository, repo = _repo_with_fake_table(handler)
    _unslotted_store(repo, repository, 200)
    pinned = {"cat0000": 19, "cat0060": 3, "cat0120": 12, "coffee": 9, "transport": 5}
    for cat_id, slot in pinned.items():
        repo._table.store[_CFG]["items"][cat_id][_SLOT] = Decimal(slot)

    _drain(repo)

    stored = repo._table.store[_CFG]["items"]
    assert {cid: int(stored[cid][_SLOT]) for cid in pinned} == pinned
    assert all(_SLOT in cat for cat in stored.values())


def test_every_built_in_pass_one_entitles_is_stamped_by_the_first_chunk(handler):
    # WHIT-405 [A9] / WHIT-428. Ids sorting BEFORE every built-in used to push all 13 seeds
    # past the first chunk, which was the user-visible risk of chunking. Since WHIT-428 the
    # chunk is a prefix of the DRAIN ORDER, and pass 1 is emitted first — so a built-in
    # entitled to its designation can never fall past chunk 1. That is not a nicety: it is
    # what makes chunking equivalent to one shot now that pass 2's overflow moves.
    #
    # NOTE the premise must be read off color_slot_plan_order, not sorted(). Computing it from
    # sorted() still "passes" while asserting nothing about what the code actually writes.
    repository, repo = _repo_with_fake_table(handler)
    early = {f"aaa{index:04d}": {"id": f"aaa{index:04d}", "name": "A", "icon": "tag",
                                 "color": "#888888", "bucket": "Lifestyle", "parent": None}
             for index in range(60)}
    _legacy_store(repo, repository, extra=early)
    plan = repository.plan_color_slot_backfill(repo._table.store[_CFG]["items"])
    first_chunk = repository.color_slot_plan_order(plan)[:50]
    entitled = [cid for cid, slot in plan.items()
                if repository.SEED_CATEGORIES.get(cid, {}).get(_SLOT) == slot]
    assert len(entitled) == 13
    assert set(entitled) <= set(first_chunk), "a built-in's designation slipped past chunk 1"

    _drain(repo)

    stored = repo._table.store[_CFG]["items"]
    assert {cid: int(stored[cid][_SLOT]) for cid in repository.SEED_CATEGORIES} == SEED_SLOTS


def test_a_chunk_that_loses_the_version_race_writes_nothing_and_a_later_read_recovers(handler):
    # WHIT-405 — [A10] a partial write is conditional too. A concurrent writer bumping the
    # version between this read's plan and its write must make the chunk a clean no-op — no
    # half-stamped rows, no marker — and the next read must still converge.
    repository, repo = _repo_with_fake_table(handler)
    _unslotted_store(repo, repository, 200)
    repo._table.before_update.append(_bump_version)

    repo.list_categories()

    stored = repo._table.store[_CFG]
    assert not any(_SLOT in cat for cat in stored["items"].values()), "a lost race half-wrote"
    assert "colorSlotSchema" not in stored

    _drain(repo)
    assert repo._table.store[_CFG]["colorSlotSchema"] == _schema()
    assert all(_SLOT in cat for cat in repo._table.store[_CFG]["items"].values())


# ---- WHIT-404: repeats past 20 categories spread instead of piling onto one slot ------------

def test_a_create_on_a_saturated_store_cannot_steal_a_slot_the_backfill_owes(handler):
    """The bug WHIT-404's first design shipped. An owed slot is held by NOBODY, so if the
    reservation were a WEIGHT rather than a hard exclusion it would tie with the singly-held
    slots and the tie-break would hand it straight over — permanently repainting the row the
    backfill was about to colour.

    The owed slot must be a NON-SEED slot for this to discriminate: if it belonged to a
    built-in, the non-seed preference would steer away from it by accident and the test would
    pass against the broken design too."""
    repository, repo = _repo_with_fake_table(handler)
    items = {cat_id: dict(seed) for cat_id, seed in repository.SEED_CATEGORIES.items()}
    # Every non-seed slot held EXCEPT 2, so the planner owes 2 to the one unslotted row.
    # (WHIT-415 moved coffee onto slot 9 and freed slot 4, so the non-seed set shifted.)
    for index, slot in enumerate([3, 4, 5, 12, 14, 19]):
        items[f"custom{index}"] = _cat(f"custom{index}", colorSlot=Decimal(slot))
    items["aaa"] = _cat("aaa")                          # unslotted -> owed the lowest free slot
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES",
                               "items": items, "version": Decimal(1)}
    owed = repository.plan_color_slot_backfill(items)["aaa"]
    assert owed == 2, "fixture drifted: the unslotted row must be owed a non-seed slot"
    # The pre-loop backfill loses its race, so aaa is still unslotted when the slot is chosen.
    repo._table.before_update.append(_bump_version)

    created = repo.create_category("wine", "Wine", "Lifestyle", "glass")

    assert created["colorSlot"] != owed, "create stole the slot the backfill owed aaa"
    assert created["colorSlot"] == 3
    # And aaa really does still get that slot once the drain catches up.
    repo.list_categories()
    assert int(repo._table.store[_CFG]["items"]["aaa"]["colorSlot"]) == owed


def test_every_slot_holds_two_categories_before_any_slot_holds_three(handler):
    """The card's actual complaint: 30 categories used to leave 23 of them sharing one colour.
    Round-robin means the ramp fills evenly — and the seven slots no built-in owns go first."""
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()                                    # 13 seeds
    slots = [int(repo.create_category(f"x{n}", f"X{n}", "Lifestyle", "tag")["colorSlot"])
             for n in range(27)]                              # categories 14 .. 40

    non_seed = sorted(frozenset(range(20)) - set(SEED_SLOTS.values()))
    assert slots[:7] == non_seed                              # lap 1: the free slots
    assert slots[7:14] == non_seed                            # lap 2: double up on those FIRST
    assert sorted(slots[14:]) == sorted(SEED_SLOTS.values())  # only then the built-ins
    holders = Counter(int(cat["colorSlot"])
                      for cat in repo._table.store[_CFG]["items"].values())
    assert set(holders) == set(range(20)) and set(holders.values()) == {2}


def test_the_backfill_planner_is_a_fixed_point_on_its_own_drain_order(handler):
    """Since WHIT-428 there is ONE assigner: create and the backfill planner both spread via
    least_held_color_slot. What keeps WHIT-405's chunked drain equivalent to one unchunked
    write is no longer a constant overflow — it is the ORDER. Persisting a prefix of
    color_slot_plan_order and re-planning must reproduce the one-shot plan exactly.

    This is the fail-on-revert guard for the order. Swap color_slot_plan_order back to
    sorted() and it diverges on 132 of these 250 stores, because an alphabetically-early
    overflow row can then be persisted onto a slot pass 1 had claimed for a built-in, and the
    robbed built-in lands somewhere new on the re-plan. Under the old CONSTANT overflow the
    robbed row fell through to the same value, which is why sorted() used to be safe.

    Not the only thing that catches it — WHIT-405's chunk-equivalence tests do too. This one
    isolates the PURE planner from the write path, so its failure names the rule rather than a
    drain that happens to disagree."""
    import random
    import repository_category
    repository, _ = _repo_with_fake_table(handler)
    rng = random.Random(404)
    chunk = repository_category._COLOR_SLOT_WRITE_CHUNK

    for trial in range(250):
        original = _random_legacy_store(repository, rng)
        one_shot = repository.plan_color_slot_backfill(copy.deepcopy(original))
        order = repository.color_slot_plan_order(one_shot)[:chunk]
        partial = copy.deepcopy(original)
        for cat_id in order:                                  # persist the first chunk
            partial[cat_id][_SLOT] = Decimal(one_shot[cat_id])
        replanned = repository.plan_color_slot_backfill(partial)

        drained = {cid: one_shot[cid] for cid in order}
        drained.update(replanned)
        assert drained == one_shot, f"trial {trial}: chunked planning diverged from one shot"


# ---- WHIT-404 QA: the adversarial half -----------------------------------------------------
# The tests above cover the RULE (least_held_color_slot as a pure function) and one clean run of
# creates on a pristine store. These cover the rule THROUGH create_category on stores that are
# contended, uneven, mid-drain, or corrupt. Every expected value comes from the real exported
# functions or is read back out of the store — nothing re-derives the rule.

def _slot_histogram(repo):
    """Every slot 0-19 -> how many stored categories hold it, read back out of the fake table."""
    held = Counter(int(cat[_SLOT]) for cat in repo._table.store[_CFG]["items"].values()
                   if _SLOT in cat)
    return Counter({slot: held.get(slot, 0) for slot in range(20)})


def test_two_creates_racing_on_a_saturated_store_still_land_on_different_slots(handler):
    # [A6] contention past 20 categories. test_two_creates_racing_never_land_on_the_same_slot
    # proves the loser re-reads BELOW saturation, where "is this slot taken" still discriminates.
    # Past 20 every slot is taken, so only the COUNT does.
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()
    for n in range(7):
        repo.create_category(f"x{n}", f"X{n}", "Lifestyle", "tag")   # 20 live: every slot held once
    assert set(_slot_histogram(repo).values()) == {1}, "fixture drifted: store is not saturated"

    def concurrent_create(item):
        item["items"]["beer"] = _cat("beer", "Lifestyle", colorSlot=Decimal(2))
        item["version"] = item["version"] + 1
    repo._table.before_update.append(concurrent_create)

    created = repo.create_category("wine", "Wine", "Lifestyle", "glass")

    holders = _slot_histogram(repo)
    assert created["colorSlot"] != 2, "the loser piled onto the slot the winner just doubled"
    assert created["colorSlot"] == 3
    assert holders[2] == 2 and holders[3] == 2
    assert max(holders.values()) == 2       # no slot reached three while another sat on one


def test_a_delete_at_saturation_hands_the_freed_capacity_to_the_next_create(handler):
    # [A7] Below 20 a delete makes a slot FREE and the free branch reuses it (already covered).
    # Past 20 a delete usually only makes a slot LESS HELD — that count has to drop for real, or
    # the ramp stays permanently uneven after any deletion.
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()
    for n in range(9):
        repo.create_category(f"x{n}", f"X{n}", "Lifestyle", "tag")   # 22 live: slots 2 and 3 doubled
    holders = _slot_histogram(repo)
    assert holders[2] == 2 and holders[3] == 2, "fixture drifted"
    stored = repo._table.store[_CFG]["items"]
    assert int(stored["x7"][_SLOT]) == 2

    repo.delete_category("x7")                       # one of slot 2's two holders
    assert _slot_histogram(repo)[2] == 1

    # The freed capacity, not the next non-seed slot along: 2 is the least-held again.
    assert repo.create_category("wine", "Wine", "Lifestyle", "glass")["colorSlot"] == 2

    repo.delete_category("x1")
    repo.delete_category("x8")                       # both of slot 3's holders
    assert _slot_histogram(repo)[3] == 0
    # Genuinely free again -> the free branch, exactly as below 20 categories.
    assert repo.create_category("beer", "Beer", "Lifestyle", "glass")["colorSlot"] == 3
    assert max(_slot_histogram(repo).values()) == 2


def test_creates_mid_drain_on_a_saturated_store_spread_without_touching_an_owed_slot(handler):
    # [A8] the WHIT-405 chunked drain crossed with saturation. The first three creates land
    # mid-drain: `reserved` covers all 13 built-in slots, so they are squeezed into the seven the
    # ramp has left, every one already held — the only place the hard exclusion and the least-held
    # rule both bind. By the fourth the drain has finished and `reserved` is empty; it spreads on
    # the least-held rule alone, which is worth keeping because it proves a new create walks AWAY
    # from the legacy slot-0 pile-up (slot 0 is held 194 times by then).
    repository, repo = _repo_with_fake_table(handler)
    _unslotted_store(repo, repository, 200)          # 213 rows, none slotted
    repo.list_categories()                           # chunk 1 lands; the rest is still owed

    got = [repo.create_category(f"w{n}", f"W{n}", "Lifestyle", "glass")["colorSlot"]
           for n in range(4)]

    # WHIT-428 dropped an `isdisjoint(SEED_SLOTS)` assertion here. It was WRONG, not merely
    # stale: 8/13/15 are built-in hues the create is legitimately DOUBLING UP on, not stealing
    # — under the drain order all 13 built-ins are stamped in chunk 1, so by now nothing is
    # owed to them at all. The theft case it was reaching for needs a store where a built-in's
    # hue is still owed, which is
    # test_a_create_cannot_rob_a_builtin_when_the_spread_backfill_owes_every_slot.
    assert len(set(got)) == 4, f"four creates mid-drain shared a colour: {got}"
    assert got == [2, 8, 13, 15]

    _drain(repo, limit=30)
    stored = repo._table.store[_CFG]["items"]
    assert all(_SLOT in cat for cat in stored.values()), "a row was left permanently unslotted"
    # The built-ins still land on the hues they were solved for...
    assert {cid: int(stored[cid][_SLOT]) for cid in SEED_SLOTS} == SEED_SLOTS
    # ...and no created row was repainted by a later chunk.
    assert [int(stored[f"w{n}"][_SLOT]) for n in range(4)] == got


def test_every_create_takes_a_least_held_slot_however_uneven_the_ramp_is(handler):
    # [A9] the invariant, over randomised create/delete churn. The evenness test above is a
    # straight run on a pristine store where the histogram is flat at every step. DELETES make it
    # uneven, and an uneven ramp is the only thing separating "least-held" from "round-robin".
    # The expected value is read out of the STORE before each create, never re-derived.
    import random
    rng = random.Random(404)
    saturated_creates = 0

    for trial in range(40):
        _, repo = _repo_with_fake_table(handler)
        repo.list_categories()
        made = 0
        for _ in range(50):
            items = repo._table.store[_CFG]["items"]
            if len(items) <= 21 or rng.random() < 0.72:
                before = _slot_histogram(repo)
                made += 1
                slot = int(
                    repo.create_category(f"c{made}", f"C{made}", "Lifestyle", "tag")[_SLOT])
                if min(before.values()) > 0:
                    saturated_creates += 1
                assert before[slot] == min(before.values()), (
                    f"trial {trial}: create took slot {slot} (held {before[slot]} times) while "
                    f"{min(before.values())} was the least-held count")
            else:
                repo.delete_category(rng.choice(sorted(items)))
            # ...and below 20 live categories nothing changed: the colours are still all distinct.
            live = _slot_histogram(repo)
            if sum(live.values()) <= 20:
                assert max(live.values()) == 1, f"trial {trial}: a duplicate under 20 categories"

    # Guard the guard: if the generator stopped reaching saturation this would test nothing.
    assert saturated_creates >= 200, saturated_creates


def test_color_slot_counts_counts_duplicates_and_still_dedupes_to_the_taken_set(handler):
    # [A10] the derivation, and the _coerce_slot boundary (19 in, 20 out) it depends on —
    # that coercion is all that stands between a corrupt row and an undefined colour on the
    # client. A set masquerading as a Counter passes every duplicate-free test in the suite,
    # then silently turns the whole least-held rule back into lowest-free.
    import repository
    items = {
        "lo": _cat("lo", colorSlot=Decimal(0)),
        "lo2": _cat("lo2", colorSlot=Decimal(0)),        # DUPLICATE: counts 2, used still {0}
        "hi": _cat("hi", colorSlot=Decimal(19)),
        "over": _cat("over", colorSlot=Decimal(20)),     # exactly at the limit -> out
        "exp": _cat("exp", colorSlot=Decimal("1E+1")),   # 10, in exponent form
        "ten": _cat("ten", colorSlot=Decimal(10)),       # the same slot by another spelling
        "huge": _cat("huge", colorSlot=Decimal("1E+30")),
        "nan": _cat("nan", colorSlot=Decimal("NaN")),
        "inf": _cat("inf", colorSlot=Decimal("Infinity")),
        "neg": _cat("neg", colorSlot=Decimal(-1)),
        "frac": _cat("frac", colorSlot=Decimal("3.5")),
        "bool": _cat("bool", colorSlot=True),            # bool subclasses int — must read as junk
        "none": _cat("none", colorSlot=None),
        "dict": _cat("dict", colorSlot={"n": 3}),
        "blank": _cat("blank", colorSlot="  "),
        "float": _cat("float", colorSlot=7.0),           # DynamoDB never returns a float
        "absent": _cat("absent"),
    }

    counts = repository.color_slot_counts(items)

    assert counts == Counter({0: 2, 10: 2, 19: 1})
    assert set(counts) == {0, 10, 19}
    assert 5 not in counts and counts[5] == 0 and 5 not in counts   # a read must not INSERT
    # The real consumer agrees: the planner treats exactly those three as taken.
    plan = repository.plan_color_slot_backfill(items)
    assert len(plan) == 12
    assert set(plan.values()).isdisjoint({0, 10, 19})


def test_a_legacy_store_of_thirty_categories_spreads_its_repeats(handler):
    # [A11] WHIT-428 closed the scope gap WHIT-404 recorded here, and this is where that
    # decision is written down. WHIT-404 spread repeats on the CREATE path only; the backfill
    # kept a constant slot-0 overflow, because WHIT-405's chunked drain was equivalent to one
    # unchunked write ONLY while that overflow was constant. So a store MIGRATING with 30
    # categories used to land 11 of them on Eating Out's colour — permanently, since a slot is
    # never recomputed. Teaching pass 2 the least-held rule needed the drain order to change
    # too (see color_slot_plan_order); with both, the same store now lands 2 per colour.
    repository, repo = _repo_with_fake_table(handler)
    _unslotted_store(repo, repository, 17)           # 13 built-ins + 17 custom = 30, none slotted

    _drain(repo)

    holders = _slot_histogram(repo)
    assert sum(holders.values()) == 30
    assert holders[0] == 2, "Eating Out's colour is piled again — did the overflow stop moving?"
    assert sorted(holders.values()) == [1] * 10 + [2] * 10
    assert max(holders.values()) == 2
    stored = repo._table.store[_CFG]["items"]
    assert {cid: int(stored[cid][_SLOT]) for cid in SEED_SLOTS} == SEED_SLOTS


def test_a_create_may_never_take_a_free_slot_a_builtin_is_owed_even_when_all_are_owed(handler):
    # [A12] the fallback branch, END TO END. The unit test pins the branch's return value; this
    # pins what it costs the user. When the plan owes all 20 slots `candidates` is empty, and if
    # that fallback reaches the FREE branch it hands out a slot that is free only because the
    # backfill has not written it yet — the exact theft `reserved` exists to stop.
    repository, repo = _repo_with_fake_table(handler)
    items = {cid: {k: v for k, v in seed.items() if k != _SLOT}
             for cid, seed in repository.SEED_CATEGORIES.items()}
    items["zsquatter"] = _cat("zsquatter", colorSlot=Decimal(0))
    for n in range(21):
        items[f"cat{n:04d}"] = _cat(f"cat{n:04d}")
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES",
                               "items": items, "version": Decimal(1)}
    owed = repository.plan_color_slot_backfill(items)
    assert set(owed.values()) == set(range(20)), "fixture drifted: not every slot is owed"
    assert owed["travel"] == 1
    repo._table.before_update.append(_bump_version)   # the pre-loop backfill loses its race

    created = repo.create_category("wine", "Wine", "Lifestyle", "glass")

    assert created["colorSlot"] != owed["travel"], "create stole the slot the backfill owed travel"
    _drain(repo, limit=30)
    stored = repo._table.store[_CFG]["items"]
    assert int(stored["travel"][_SLOT]) == 1, "travel was repainted off its designated hue"
    assert all(_SLOT in cat for cat in stored.values())


def test_a_create_cannot_rob_a_builtin_when_the_spread_backfill_owes_every_slot(handler):
    # WHIT-428 — the fail-on-revert guard for `protected`. Once the backfill SPREADS, a
    # saturated store's plan owes all 20 slots for real (before, the overflow was the single
    # constant 0), so `candidates` is empty and the fallback runs — and that branch ignores
    # `reserved` by design. Without `protected` it picks the lowest zero-count slot, which is
    # eatingout's 0, and Eating Out is pushed onto 7 where it collides with Gifts. Permanently:
    # pass 1 only entitles a built-in while its slot is free.
    #
    # The fixture is the shape that exposes it: every built-in unslotted, a squatter already on
    # each of the seven non-built-in slots (so the seed slots have ZERO stored holders and win
    # the least-held tie-break), and enough custom rows to saturate.
    repository, repo = _repo_with_fake_table(handler)
    import repository_category
    items = {cid: {k: v for k, v in seed.items() if k != _SLOT}
             for cid, seed in repository.SEED_CATEGORIES.items()}
    non_seed = sorted(set(range(20)) - set(SEED_SLOTS.values()))
    assert len(non_seed) == 7
    for n, slot in enumerate(non_seed):
        items[f"squat{n}"] = _cat(f"squat{n}", colorSlot=Decimal(slot))
    for n in range(30):
        items[f"cat{n:04d}"] = _cat(f"cat{n:04d}")
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES",
                               "items": items, "version": Decimal(1)}
    owed = repository.plan_color_slot_backfill(items)
    assert set(owed.values()) == set(range(20)), "fixture drifted: not every slot is owed"
    protected = repository_category._designated_builtin_slots(owed)
    assert protected == frozenset(SEED_SLOTS.values()), "every built-in should be owed its hue"
    repo._table.before_update.append(_bump_version)   # the pre-loop backfill loses its race

    created = repo.create_category("wine", "Wine", "Lifestyle", "glass")

    assert created["colorSlot"] not in protected, \
        "create robbed a built-in of its designated hue from the all-owed fallback"
    _drain(repo, limit=30)
    stored = repo._table.store[_CFG]["items"]
    # The whole solved table survives — not just the one the create happened to aim at.
    assert {cid: int(stored[cid][_SLOT]) for cid in SEED_SLOTS} == SEED_SLOTS
    assert all(_SLOT in cat for cat in stored.values())


def test_the_backfill_plan_is_ordered_pass_one_first_so_a_chunk_cannot_rob_a_builtin(handler):
    # WHIT-428 — the pin on the load-bearing but invisible contract. `_write_color_slots` takes
    # its chunk as a prefix of color_slot_plan_order, which is just the plan's build order; a
    # stray sorted() in a future refactor would silently re-open the divergence with no obvious
    # symptom (colours would just be slightly wrong on legacy stores). Assert the order at the
    # planner end AND that the real write used it, so a break is caught at both ends.
    repository, repo = _repo_with_fake_table(handler)
    early = {f"aaa{index:04d}": {"id": f"aaa{index:04d}", "name": "A", "icon": "tag",
                                 "color": "#888888", "bucket": "Lifestyle", "parent": None}
             for index in range(60)}
    _legacy_store(repo, repository, extra=early)      # seed ids all sort AFTER the aaa rows
    items = repo._table.store[_CFG]["items"]
    plan = repository.plan_color_slot_backfill(items)

    order = repository.color_slot_plan_order(plan)
    entitled = [cid for cid, slot in plan.items()
                if repository.SEED_CATEGORIES.get(cid, {}).get(_SLOT) == slot]
    assert order[:len(entitled)] == sorted(entitled), "pass-1 rows are no longer emitted first"
    assert order[len(entitled):] == sorted(order[len(entitled):]), "pass 2 is not alphabetical"
    assert order != sorted(order), "fixture drifted: the order is indistinguishable from sorted"

    repo.list_categories()                            # one chunk lands
    names = repo._table.update_calls[-1][1]            # (expression, names, values)
    written = [names[f"#cat{index}"] for index in range(len(names)) if f"#cat{index}" in names]
    assert written == order[:50], "the write did not use the drain order"


# ---- WHIT-428: the one-off repaint of already-migrated, piled stores ------------------------
# PART 1 above stops FUTURE migrations piling. These cover the second half: stores that already
# migrated under the old constant slot-0 overflow are levelled once, behind a schema-2 marker,
# then never again. Every expected value comes from the real exported planners or is read back
# out of the store — nothing re-derives the rule.


def _piled_store(repo, repository, count, *, slot=0, schema=1):
    """An ALREADY-migrated store whose custom rows are all piled onto one colour — what the
    old constant-overflow backfill actually produced. Built-ins sit on their designated hues."""
    items = {cid: dict(cat) for cid, cat in repository.SEED_CATEGORIES.items()}
    for index in range(count):
        cat_id = f"cat{index:04d}"
        items[cat_id] = _cat(cat_id, colorSlot=Decimal(slot))
    item = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": items, "version": Decimal(1),
            "colorSlotSchema": Decimal(schema)}
    repo._table.store[_CFG] = item
    return item


def test_a_store_that_already_migrated_onto_one_shared_slot_is_repainted_level(handler):
    # The card's own example, from the other side: this store already finished its migration
    # under the old rule, so PART 1 alone plans NOTHING for it — every row holds a valid slot.
    # 30 rows, allowance = ceil(30/20) = 2.
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 17)               # 13 built-ins + 17 all on slot 0
    before = _slot_histogram(repo)
    assert before[0] == 18, "fixture drifted: the store is not piled"
    assert repository.plan_color_slot_backfill(repo._table.store[_CFG]["items"]) == {}

    _drain(repo)

    holders = _slot_histogram(repo)
    assert sum(holders.values()) == 30
    assert max(holders.values()) == 2
    stored = repo._table.store[_CFG]["items"]
    assert {cid: int(stored[cid][_SLOT]) for cid in SEED_SLOTS} == SEED_SLOTS
    assert repo._table.store[_CFG]["colorSlotSchema"] == _schema()


def test_an_already_level_store_is_stamped_without_repainting_anything(handler):
    # The population that must cost as little as possible: schema 1, already level. One
    # marker-only write, no colour touched, then silent forever. This is also the
    # fail-on-revert guard for the schema bump — revert _COLOR_SLOT_SCHEMA to 1 and the
    # marker-only write never happens, so `writes` is 0 and this reddens.
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 0)                # 13 built-ins, each on its own hue
    before = {cid: int(cat[_SLOT]) for cid, cat in repo._table.store[_CFG]["items"].items()}

    writes = _drain(repo)

    assert writes == 1
    expression, names, values = repo._table.update_calls[-1]
    assert set(names) == {"#v", "#schema"}, "an already-level store rewrote a colour"
    assert values[":schema"] == _schema()
    assert {cid: int(cat[_SLOT])
            for cid, cat in repo._table.store[_CFG]["items"].items()} == before


def test_a_repaint_never_moves_the_sole_holder_of_a_colour(handler):
    # The permanence promise: a colour worn by ONE category is never a mover. The guard is on
    # the `holders[allowance:]` boundary in _repaint_movers — make it `allowance - 1` and this
    # reddens. (It is NOT a guard on the allowance arithmetic: ceil(n/20) is already >= 1 for
    # every non-empty store, so there is nothing there to get wrong.)
    repository, repo = _repo_with_fake_table(handler)
    items = {cid: dict(cat) for cid, cat in repository.SEED_CATEGORIES.items()}
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": items,
                               "version": Decimal(1), "colorSlotSchema": Decimal(1)}
    assert repository.plan_color_slot_repaint(items) == {}
    before = {cid: int(cat[_SLOT]) for cid, cat in items.items()}

    _drain(repo)

    assert {cid: int(cat[_SLOT])
            for cid, cat in repo._table.store[_CFG]["items"].items()} == before


def test_a_built_in_on_its_designated_slot_is_never_the_row_that_moves(handler):
    # Keeper priority. eatingout shares slot 0 with custom rows that sort BEFORE it
    # alphabetically, so plain alphabetical order would evict the built-in. Its designation
    # must win instead — a built-in never loses the hue it was solved for.
    repository, repo = _repo_with_fake_table(handler)
    items = {cid: dict(cat) for cid, cat in repository.SEED_CATEGORIES.items()}
    for index in range(20):
        cat_id = f"aaa{index:04d}"                   # sorts before "eatingout"
        items[cat_id] = _cat(cat_id, colorSlot=Decimal(0))
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": items,
                               "version": Decimal(1), "colorSlotSchema": Decimal(1)}
    plan = repository.plan_color_slot_repaint(items)
    assert "eatingout" not in plan, "the repaint evicted a built-in from its designated hue"

    _drain(repo)

    stored = repo._table.store[_CFG]["items"]
    assert {cid: int(stored[cid][_SLOT]) for cid in SEED_SLOTS} == SEED_SLOTS


def test_a_repaint_moves_the_theoretical_minimum_number_of_rows(handler):
    # Minimal churn, tested rather than commented. Every moved colour is a colour some user
    # watched change, so "only the rows above the allowance move" has to be enforced: a full
    # re-plan would move ~24% more, including rows a POST already told the client about.
    import random
    repository, _ = _repo_with_fake_table(handler)
    rng = random.Random(428)
    checked = 0

    for _ in range(120):
        items = {}
        for index in range(rng.randint(1, 90)):
            cat_id = f"cat{index:04d}"
            items[cat_id] = _cat(cat_id, colorSlot=Decimal(rng.randrange(20)))
        allowance = max(1, -(-len(items) // 20))
        counts = Counter(int(cat[_SLOT]) for cat in items.values())
        minimum = sum(max(0, held - allowance) for held in counts.values())
        assert len(repository.plan_color_slot_repaint(items)) == minimum
        checked += minimum > 0

    assert checked >= 40, f"the generator stopped producing piled stores: {checked}"


def test_a_chunked_repaint_lands_exactly_where_one_unchunked_write_would_have(handler):
    # The repaint's own [A1]. The allowance depends ONLY on how many rows the store has, never
    # on where they sit, so persisting a prefix leaves the re-plan looking at the same number —
    # which is what makes the chunked repaint equivalent to one unchunked write. Verified over
    # randomised piled stores, with the write count bounded by the number of chunks.
    import random
    import repository_category
    repository, _ = _repo_with_fake_table(handler)
    rng = random.Random(_PROPERTY_SEED + 2)
    chunk = repository_category._COLOR_SLOT_WRITE_CHUNK
    saw_multi_chunk = 0

    for trial in range(120):
        _, repo = _repo_with_fake_table(handler)
        items = {cid: dict(cat) for cid, cat in repository.SEED_CATEGORIES.items()}
        for index in range(rng.randint(30, 200)):
            cat_id = f"cat{index:04d}"
            items[cat_id] = _cat(cat_id, colorSlot=Decimal(rng.choice([0, 0, 0, 1, 2])))
        repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES",
                                   "items": copy.deepcopy(items), "version": Decimal(1),
                                   "colorSlotSchema": Decimal(1)}
        one_shot = repository.plan_color_slot_repaint(copy.deepcopy(items))
        expected = {cid: int(one_shot[cid]) if cid in one_shot else int(cat[_SLOT])
                    for cid, cat in items.items()}
        if len(one_shot) > chunk:
            saw_multi_chunk += 1

        writes = _drain(repo, limit=40)

        stored = repo._table.store[_CFG]["items"]
        assert {cid: int(cat[_SLOT]) for cid, cat in stored.items()} == expected, \
            f"trial {trial}: chunked repaint diverged from one shot"
        assert writes == max(1, -(-len(one_shot) // chunk)), f"trial {trial}: {writes} writes"

    assert saw_multi_chunk >= 20, saw_multi_chunk


def test_the_repaint_planner_is_a_fixed_point_on_its_own_drain_order(handler):
    # The repaint's [A2], isolating the PURE planner from the write path so a failure names the
    # rule rather than a drain that happens to disagree. Same shape as the backfill's.
    import random
    import repository_category
    repository, _ = _repo_with_fake_table(handler)
    rng = random.Random(_PROPERTY_SEED + 3)
    chunk = repository_category._COLOR_SLOT_WRITE_CHUNK

    for trial in range(150):
        items = {cid: dict(cat) for cid, cat in repository.SEED_CATEGORIES.items()}
        for index in range(rng.randint(30, 150)):
            cat_id = f"cat{index:04d}"
            items[cat_id] = _cat(cat_id, colorSlot=Decimal(rng.choice([0, 0, 1, 2, 3])))
        one_shot = repository.plan_color_slot_repaint(copy.deepcopy(items))
        order = repository.color_slot_plan_order(one_shot)[:chunk]
        partial = copy.deepcopy(items)
        for cat_id in order:
            partial[cat_id][_SLOT] = Decimal(one_shot[cat_id])

        # Guard the guard: an empty plan compares {} to {} and would pass forever.
        assert one_shot, f"trial {trial}: fixture drifted, nothing to repaint"

        replanned = repository.plan_color_slot_repaint(partial)
        drained = {cid: one_shot[cid] for cid in order}
        drained.update(replanned)
        assert drained == one_shot, f"trial {trial}: chunked repaint planning diverged"


def test_repainting_a_store_twice_changes_nothing(handler):
    # Safe to run twice — but the teeth are in WHAT it settled on, not just that it stopped:
    # a repaint stubbed out to do nothing would also "settle" and never write again.
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 60)
    _drain(repo)
    settled = {cid: int(cat[_SLOT]) for cid, cat in repo._table.store[_CFG]["items"].items()}
    holders = _slot_histogram(repo)
    assert max(holders.values()) <= -(-sum(holders.values()) // 20), "settled while still piled"
    repo._table.update_calls.clear()

    repo.list_categories()
    repo.list_categories()

    assert repo._table.update_calls == []
    assert {cid: int(cat[_SLOT])
            for cid, cat in repo._table.store[_CFG]["items"].items()} == settled


def test_a_store_already_at_schema_two_is_never_repainted_even_when_piled(handler):
    # "At most once" — the fail-on-revert guard for the marker actually gating stage 2. A store
    # stamped schema 2 that is nonetheless piled (however it got that way) must be left alone:
    # a colour the user has been shown does not change twice.
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 40, schema=2)
    items = repo._table.store[_CFG]["items"]
    assert repository.plan_color_slot_repaint(items) != {}, "fixture drifted: not piled"
    before = {cid: int(cat[_SLOT]) for cid, cat in items.items()}

    repo.list_categories()
    repo.list_categories()

    assert repo._table.update_calls == []
    assert {cid: int(cat[_SLOT])
            for cid, cat in repo._table.store[_CFG]["items"].items()} == before


def test_a_delete_that_lowers_the_allowance_does_not_reopen_a_settled_store(handler):
    # This is what separates "the rule genuinely converges" from "the marker is quietly
    # carrying the whole thing". 41 rows -> allowance 3; delete one -> 40 rows -> allowance 2,
    # so the PLANNER would now find movers. The settled store must still do nothing.
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 28)               # 13 + 28 = 41 rows
    _drain(repo)
    assert max(_slot_histogram(repo).values()) == 3

    # Delete a row that is NOT on the crowded slot, so that slot still holds 3 while the
    # allowance drops to 2 — otherwise the delete itself levels the store and proves nothing.
    stored = repo._table.store[_CFG]["items"]
    crowded = _slot_histogram(repo).most_common(1)[0][0]
    victim = next(cid for cid, cat in stored.items()
                  if int(cat[_SLOT]) != crowded and cid not in SEED_SLOTS)
    repo.delete_category(victim)
    items = repo._table.store[_CFG]["items"]
    assert len(items) == 40
    assert repository.plan_color_slot_repaint(items) != {}, "the allowance did not drop"
    before = {cid: int(cat[_SLOT]) for cid, cat in items.items()}
    repo._table.update_calls.clear()

    repo.list_categories()

    assert repo._table.update_calls == []
    assert {cid: int(cat[_SLOT])
            for cid, cat in repo._table.store[_CFG]["items"].items()} == before


def test_a_repaint_in_progress_shows_the_same_colours_on_every_read(handler):
    # The narrowed promise, pinned on the STABLE case: with no create or delete interleaved, a
    # user reloading mid-repaint sees an identical colour map every time. (An interleaved write
    # DOES shift not-yet-written rows — accepted deliberately, documented on `colorSlot`.)
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 140)
    views = []

    for _ in range(20):
        before = len(repo._table.update_calls)
        views.append({row["id"]: row[_SLOT] for row in repo.list_categories()})
        if len(repo._table.update_calls) == before:
            break
    else:
        raise AssertionError("the repaint did not converge")

    assert len(views) > 2, "fixture drifted: the repaint finished in a single write"
    assert all(view == views[0] for view in views), \
        "a colour previewed mid-repaint changed with nothing else touching the store"


def test_no_row_written_by_one_repaint_chunk_is_ever_rewritten(handler):
    # The other half: storage never moves a row twice, even when a create and a delete land
    # between chunks. A colour that has actually been SAVED is permanent.
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 140)
    original = {cid: int(cat[_SLOT])
                for cid, cat in repo._table.store[_CFG]["items"].items()}
    # A row is "written by the repaint" once its stored slot differs from the piled value it
    # started on. From that moment its colour is saved, and must never change again.
    moved = {}

    for step in range(20):
        before = len(repo._table.update_calls)
        repo.list_categories()
        stored = repo._table.store[_CFG]["items"]
        for cat_id, cat in stored.items():
            slot = int(cat[_SLOT])
            if original.get(cat_id) is not None and slot != original[cat_id]:
                assert moved.setdefault(cat_id, slot) == slot, \
                    f"{cat_id} was rewritten from {moved[cat_id]} to {slot}"
        if len(repo._table.update_calls) == before:
            break
        if step == 0:
            repo.create_category("wine", "Wine", "Lifestyle", "glass")
        if step == 1:
            repo.delete_category("cat0001")

    assert moved, "fixture drifted: the repaint never moved anything"


def test_a_repaint_expression_never_exceeds_dynamodbs_4kb_limit(handler):
    # The repaint reuses the backfill's write shape, so FakeTable's 4KB guard applies to it
    # too — but nothing exercised it through a repaint plan until now.
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 200)

    _drain(repo, limit=40)

    biggest = max(len(call[0].encode()) for call in repo._table.update_calls)
    # Guard the guard: a marker-only write is ~60 bytes and would pass this trivially. A full
    # 50-clause chunk is what has to fit, so require the fixture actually produced one.
    assert biggest > 1000, f"fixture drifted: the biggest write was only {biggest} bytes"
    assert biggest < 4096 // 2, f"a repaint write reached {biggest} bytes"


def test_a_store_needing_both_a_backfill_and_a_repaint_is_not_stamped_until_both_land(handler):
    # The `settled` flag. A store with an unslotted row AND a pre-existing pile needs both
    # stages; stamping on the backfill's last chunk would strand the repaint's row on a shared
    # colour permanently. Drop `settled` from `drained` and this reddens.
    repository, repo = _repo_with_fake_table(handler)
    items = {cid: dict(cat) for cid, cat in repository.SEED_CATEGORIES.items()}
    for index in range(24):                          # piled onto eatingout's hue
        cat_id = f"cat{index:04d}"
        items[cat_id] = _cat(cat_id, colorSlot=Decimal(0))
    items["zzznew"] = _cat("zzznew")                 # ...and one row with no slot at all
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": items,
                               "version": Decimal(1), "colorSlotSchema": Decimal(1)}
    assert repository.plan_color_slot_backfill(items) != {}

    repo.list_categories()                           # the backfill stage lands, alone
    config = repo._table.store[_CFG]
    assert repository.plan_color_slot_backfill(config["items"]) == {}, "backfill did not finish"
    assert repository.plan_color_slot_repaint(config["items"]) != {}, "fixture is not piled"
    assert "colorSlotSchema" not in config or config["colorSlotSchema"] != _schema(), \
        "stamped while the repaint was still owed"

    _drain(repo)

    assert repo._table.store[_CFG]["colorSlotSchema"] == _schema()
    assert max(_slot_histogram(repo).values()) <= 2


def test_a_create_mid_backfill_keeps_its_slot_once_the_repaint_has_also_run(handler):
    # WHIT-428's create-path cap, END TO END — the bug the plan critic found. Mid-backfill the
    # stored counts cover only the rows already stamped, while the repaint's allowance is
    # computed from the WHOLE store. Without the cap the create picks a slot the backfill then
    # piles past the allowance, and the repaint evicts the freshly created row — repainting a
    # colour the POST had already told the client about. 69 unslotted + 5 already on slot 2,
    # and an id that sorts after them so it is the lowest-priority keeper. Without the cap the
    # POST returns slot 2 and the store settles it on 0; with it, POST and storage agree.
    repository, repo = _repo_with_fake_table(handler)
    items = {cid: dict(cat) for cid, cat in repository.SEED_CATEGORIES.items()}
    for index in range(5):
        cat_id = f"crowd{index}"
        items[cat_id] = _cat(cat_id, colorSlot=Decimal(2))
    for index in range(69):
        cat_id = f"cat{index:04d}"
        items[cat_id] = _cat(cat_id)                 # unslotted
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": items,
                               "version": Decimal(1)}

    created = repo.create_category("zwine", "Wine", "Lifestyle", "glass")
    _drain(repo, limit=40)

    stored = repo._table.store[_CFG]["items"]
    assert int(stored["zwine"][_SLOT]) == created[_SLOT], \
        "the repaint evicted the row POST had already given a colour"
    assert {cid: int(stored[cid][_SLOT]) for cid in SEED_SLOTS} == SEED_SLOTS
    assert repo._table.store[_CFG]["colorSlotSchema"] == _schema()


def test_a_create_is_never_repainted_whenever_it_lands_in_the_migration(handler):
    # The property behind the test above: wherever a create lands — before the drain, between
    # chunks, or after the marker — the slot the POST returned is the slot that ends up stored.
    repository, _ = _repo_with_fake_table(handler)

    for reads_before in range(4):
        _, repo = _repo_with_fake_table(handler)
        items = {cid: dict(cat) for cid, cat in repository.SEED_CATEGORIES.items()}
        for index in range(6):
            items[f"crowd{index}"] = _cat(f"crowd{index}", colorSlot=Decimal(3))
        for index in range(90):
            items[f"cat{index:04d}"] = _cat(f"cat{index:04d}")
        repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": items,
                                   "version": Decimal(1)}
        for _ in range(reads_before):
            repo.list_categories()

        created = repo.create_category("zwine", "Wine", "Lifestyle", "glass")
        _drain(repo, limit=40)

        stored = repo._table.store[_CFG]["items"]
        assert int(stored["zwine"][_SLOT]) == created[_SLOT], \
            f"created row repainted when the create landed after {reads_before} reads"


def test_the_repaint_keys_on_the_map_key_not_the_inner_id(handler):
    # The rest of the module keys on the MAP KEY; a row whose inner "id" disagrees must be
    # planned, moved and returned under the map key, or it is stamped in the DB under one name
    # and returned under another.
    repository, repo = _repo_with_fake_table(handler)
    items = {cid: dict(cat) for cid, cat in repository.SEED_CATEGORIES.items()}
    for index in range(5):
        key = f"k{index:02d}"
        items[key] = {"id": f"zzz{4 - index}", "name": "X", "icon": "tag", "color": "#888888",
                      "bucket": "Lifestyle", "parent": None, _SLOT: Decimal(2)}
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": items,
                               "version": Decimal(1), "colorSlotSchema": Decimal(1)}

    plan = repository.plan_color_slot_repaint(items)

    assert set(plan) <= {f"k{index:02d}" for index in range(5)}
    assert "k00" not in plan, "the keeper was chosen by the inner id, not the map key"


def test_a_versionless_store_previews_the_repaint_without_ever_writing(handler):
    # No version means no optimistic lock to condition on, so the write is skipped — but the
    # read must still be correct and must never raise. The levelled colours are shown from the
    # plan; storage is untouched.
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 40)
    del repo._table.store[_CFG]["version"]
    before = {cid: int(cat[_SLOT]) for cid, cat in repo._table.store[_CFG]["items"].items()}

    rows = repo.list_categories()
    repo.list_categories()

    assert repo._table.update_calls == []
    assert {cid: int(cat[_SLOT])
            for cid, cat in repo._table.store[_CFG]["items"].items()} == before
    assert max(Counter(row[_SLOT] for row in rows).values()) <= 3


def test_a_repaint_survives_every_built_in_sitting_on_another_built_ins_slot(handler):
    # The only shape where the designation and alphabetical tie-breaks disagree: rotate the
    # seed table by one, so every built-in holds some OTHER built-in's designated hue and none
    # of them can claim keeper priority. No committed fixture produces this.
    repository, repo = _repo_with_fake_table(handler)
    designated = [SEED_SLOTS[cid] for cid in SEED_SLOTS]
    rotated = designated[1:] + designated[:1]
    items = {}
    for cat_id, slot in zip(SEED_SLOTS, rotated):
        items[cat_id] = {**repository.SEED_CATEGORIES[cat_id], _SLOT: Decimal(slot)}
    for index in range(30):
        items[f"cat{index:04d}"] = _cat(f"cat{index:04d}", colorSlot=Decimal(rotated[0]))
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": items,
                               "version": Decimal(1), "colorSlotSchema": Decimal(1)}

    _drain(repo, limit=40)

    holders = _slot_histogram(repo)
    assert max(holders.values()) <= max(1, -(-sum(holders.values()) // 20))
    assert repo._table.store[_CFG]["colorSlotSchema"] == _schema()


def test_an_empty_and_a_single_row_store_settle_in_one_write(handler):
    # Edge states. An empty store is the "every category deleted" case the marker exists for;
    # a single row has allowance 1 and must not be touched.
    repository, repo = _repo_with_fake_table(handler)
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": {},
                               "version": Decimal(1), "colorSlotSchema": Decimal(1)}

    assert _drain(repo) == 1
    assert repo._table.store[_CFG]["colorSlotSchema"] == _schema()
    assert repo.list_categories() == []

    _, repo = _repo_with_fake_table(handler)
    only = {"solo": _cat("solo", colorSlot=Decimal(4))}
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": only,
                               "version": Decimal(1), "colorSlotSchema": Decimal(1)}

    assert _drain(repo) == 1
    assert int(repo._table.store[_CFG]["items"]["solo"][_SLOT]) == 4


def test_the_planners_never_mutate_the_store_they_are_given(handler):
    # The planners are projections, not applications — list_categories holds these same row
    # objects and reads them again to build the response, so a planner writing through them
    # would hand the client colours the store does not hold. Also pins that planning twice on
    # the same input gives the same answer, which the chunked drain relies on.
    repository, repo = _repo_with_fake_table(handler)
    items = {cid: dict(cat) for cid, cat in repository.SEED_CATEGORIES.items()}
    for index in range(24):
        items[f"cat{index:04d}"] = _cat(f"cat{index:04d}", colorSlot=Decimal(0))
    items["zzznew"] = _cat("zzznew")                 # unslotted: forces the backfill stage
    before = copy.deepcopy(items)

    first = repository.plan_color_slot_stage(items, repainted=False)
    second = repository.plan_color_slot_stage(items, repainted=False)

    assert items == before, "a planner mutated the store it was handed"
    assert first == second, "planning twice on the same store gave two answers"
    assert repository.plan_new_category_slot(items) == repository.plan_new_category_slot(items)
    assert items == before, "plan_new_category_slot mutated the store it was handed"


def test_a_versionless_store_mid_backfill_previews_without_writing(handler):
    # The read must stay correct and must never raise when there is no version to condition on
    # — and storage must be untouched, including by the planners themselves.
    repository, repo = _repo_with_fake_table(handler)
    _unslotted_store(repo, repository, 40)
    del repo._table.store[_CFG]["version"]
    before = copy.deepcopy(repo._table.store[_CFG]["items"])

    rows = repo.list_categories()
    repo.list_categories()

    assert repo._table.update_calls == []
    assert repo._table.store[_CFG]["items"] == before
    assert all(0 <= row[_SLOT] < 20 for row in rows), "a preview handed out an unusable slot"


def test_editing_a_category_mid_migration_echoes_the_colour_the_list_shows(handler):
    # PATCH used to echo the row's STORED slot while GET returned the previewed one, so
    # mid-migration an edit made the category's chart colour visibly flip back to its old
    # value until the next refetch (the client writes the PATCH response straight into its
    # cached list). Both answers now come from the same planner. Echo the stored value again
    # and this reddens.
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 140)              # 153 rows: the repaint needs 3 chunks
    repo.list_categories()                           # chunk 1 lands; the rest is still owed
    listed = {row["id"]: row[_SLOT] for row in repo.list_categories()}
    # Pick the victim AFTER the last read: each read lands another chunk, so a row chosen
    # earlier may already have been written — and then its stored slot equals its previewed
    # one and the assertion below passes whatever PATCH echoes. Assert the gap explicitly.
    items = repo._table.store[_CFG]["items"]
    pending = repository.plan_color_slot_repaint(items)
    victim = next(cid for cid in pending
                  if cid.startswith("cat") and pending[cid] != int(items[cid][_SLOT]))
    assert listed[victim] != int(items[victim][_SLOT]), \
        "fixture drifted: this row's stored colour already equals its previewed one"

    edited = repo.update_category(victim, "Renamed", "Living", "tag")

    assert edited[_SLOT] == listed[victim], "PATCH echoed a colour the list does not show"
    assert type(edited[_SLOT]) is int, "PATCH must carry a plain int, like GET and POST"

    _drain(repo, limit=40)
    assert int(repo._table.store[_CFG]["items"][victim][_SLOT]) == edited[_SLOT], \
        "the colour PATCH echoed is not the one that settled"


# ---- WHIT-426: breadth is capped so delete's detach write always fits ----------------------
# delete_category detaches every child in ONE write, and DynamoDB rejects an UpdateExpression
# over 4KB — 122 children fit (4070 bytes), 123 do not (4104), which made DELETE 500. Rather
# than split the delete across writes (which would cost its atomicity), breadth is capped so
# the write can never grow that big. These pin the cap, the no-op escape hatch it needs, and
# the 400-not-500 path for data written before the cap existed.

_CAP = 50
_COLOR_SLOT_COUNT_FOR_TESTS = 20


def _parent_with_children(repo, repository, count, parent_id="coffee"):
    """`count` children under `parent_id`, written straight into the store — bypassing the
    API the way grandfathered data would have."""
    items = {cid: dict(seed) for cid, seed in repository.SEED_CATEGORIES.items()}
    bucket = items[parent_id]["bucket"]
    for index in range(count):
        child = f"kid{index:04d}"
        items[child] = _cat(child, bucket, parent=parent_id,
                            colorSlot=Decimal(index % _COLOR_SLOT_COUNT_FOR_TESTS))
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES",
                               "items": items, "version": Decimal(1),
                               "colorSlotSchema": Decimal(1)}
    return items


def test_the_pure_breadth_rule(handler):
    import repository
    items = {"p": _cat("p"), "other": _cat("other")}
    items.update({f"k{n}": _cat(f"k{n}", parent="p") for n in range(_CAP - 1)})

    # one short of the cap -> the next child is fine
    repository.validate_category_breadth(items, "new", "p")
    # children of a DIFFERENT parent don't count toward this one
    repository.validate_category_breadth(items, "new", "other")

    items[f"k{_CAP - 1}"] = _cat(f"k{_CAP - 1}", parent="p")      # now exactly at the cap
    with pytest.raises(repository.InvalidCategoryParentError, match="at most 50 sub-categories"):
        repository.validate_category_breadth(items, "new", "p")
    # ...but re-saving a child that ALREADY sits there adds nothing, so it must still pass.
    repository.validate_category_breadth(items, "k0", "p")


def test_the_cap_plus_one_child_is_refused_at_create(handler):
    repository, repo = _repo_with_fake_table(handler)
    _parent_with_children(repo, repository, _CAP)
    before = len(repo._table.store[_CFG]["items"])

    with pytest.raises(repository.InvalidCategoryParentError, match="at most 50 sub-categories"):
        repo.create_category("wine", "Wine", "Lifestyle", "glass", parent="coffee")

    assert len(repo._table.store[_CFG]["items"]) == before    # nothing was written


def test_the_cap_plus_one_child_is_refused_at_reparent(handler):
    repository, repo = _repo_with_fake_table(handler)
    items = _parent_with_children(repo, repository, _CAP)
    items["loner"] = _cat("loner", "Lifestyle")               # top-level, wants to move in

    with pytest.raises(repository.InvalidCategoryParentError, match="at most 50 sub-categories"):
        repo.update_category("loner", "Loner", "Lifestyle", "tag", parent="coffee")

    assert repo._table.store[_CFG]["items"]["loner"].get("parent") is None


def test_a_full_parent_still_accepts_a_no_op_resave_of_an_existing_child(handler):
    """The trap the no-op skip exists for: a plain name edit resubmits the stored parent. If
    the rule counted that as a new child, editing any child of a full parent would 400."""
    repository, repo = _repo_with_fake_table(handler)
    _parent_with_children(repo, repository, _CAP)

    updated = repo.update_category("kid0000", "Renamed", "Lifestyle", "tag", parent="coffee")

    assert updated["name"] == "Renamed"
    assert repo._table.store[_CFG]["items"]["kid0000"]["parent"] == "coffee"


def test_an_over_wide_legacy_parent_is_refused_not_crashed(handler):
    """Data written before the cap can still be over-wide. It must fail as a stated rule, not
    as DynamoDB rejecting a 4KB expression — that was an uncaught DatabaseError, i.e. a 500."""
    repository, repo = _repo_with_fake_table(handler)
    _parent_with_children(repo, repository, 123)             # one past what one write can hold

    with pytest.raises(repository.InvalidCategoryParentError, match="move some out"):
        repo.delete_category("coffee")

    assert "coffee" in repo._table.store[_CFG]["items"]       # nothing half-done


def test_deleting_an_over_wide_parent_returns_400_not_a_crash(handler):
    repository, repo = _repo_with_fake_table(handler)
    _parent_with_children(repo, repository, 123)

    resp = handler.delete_category(_category_item_event("DELETE", body=None),
                                   repo, FakeBudgetRepo())

    assert resp["statusCode"] == 400
    assert "move some out" in json.loads(resp["body"])["error"]


def test_a_grandfathered_parent_that_still_fits_can_still_be_deleted(handler):
    """The regression this nearly shipped with. 60 children is over the breadth cap but only
    2002 bytes — well inside the 4096 limit — so it deletes fine on main. Sizing delete's
    guard by the product cap instead of the real expression would have refused it."""
    repository, repo = _repo_with_fake_table(handler)
    _parent_with_children(repo, repository, 60)

    repo.delete_category("coffee")

    stored = repo._table.store[_CFG]["items"]
    assert "coffee" not in stored
    assert all(stored[f"kid{n:04d}"]["parent"] is None for n in range(60))
# ---- WHIT-426 adversarial half: the cap's boundaries, races, and escape hatches -------------
# The implementer's block pins the rule and the 400. This block pins the things that stay
# green when the rule is subtly wrong: the cap VALUE being safe (not just the count 50), the
# exact delete boundary, the check surviving a lost race, the branches deliberately left
# unchecked, and the fact that a refused delete is actually recoverable.


def _breadth_cap():
    """The LIVE cap, read from the module that defines it — not a literal. Every assertion
    below scales with it, so raising the constant cannot leave a breadth test quietly passing
    against a stale 50."""
    import repository_category
    return repository_category._MAX_CHILDREN_PER_CATEGORY


def _parent_with_children_and_loose_rows(repo, repository, count, extra_top_level=0):
    """The shipped `_parent_with_children` plus `extra_top_level` unparented rows, colour-
    slotted the same way, so a test can distinguish "children of coffee" from "categories"."""
    items = _parent_with_children(repo, repository, count)
    bucket = items["coffee"]["bucket"]
    for index in range(extra_top_level):
        loose = f"top{index:04d}"
        items[loose] = _cat(loose, bucket, parent=None,
                            colorSlot=Decimal(index % _COLOR_SLOT_COUNT_FOR_TESTS))
    return items


def _smallest_child_count_delete_refuses(handler):
    """The first child count delete_category will not take, DISCOVERED by asking the
    production guard rather than re-deriving its byte arithmetic here. A test that
    recomputed the budget itself would agree with a broken guard and prove nothing."""
    repository, _ = _repo_with_fake_table(handler)
    for count in range(_breadth_cap(), 400):
        repository, repo = _repo_with_fake_table(handler)
        _parent_with_children(repo, repository, count)
        try:
            repo.delete_category("coffee")
        except repository.InvalidCategoryParentError:
            return count
    raise AssertionError("delete_category never refused, even at 400 children")


# Comfortably past any plausible expression frontier, for tests that only need "refused".
_UNDELETABLY_WIDE = 400


# --- the cap VALUE, not just the number 50 ----------------------------------


def test_the_chosen_cap_is_small_enough_that_a_full_parents_delete_actually_fits(handler):
    """[A1] The card's whole promise in one line: no sequence of supported API calls can
    build a parent whose delete fails. Driven off the PRODUCTION constant, not a literal 50 —
    every other breadth test builds exactly 50 children, so raising
    _MAX_CHILDREN_PER_CATEGORY to 200 leaves them all green while a legally-full parent
    becomes undeletable again. This one grows with the constant."""
    repository, repo = _repo_with_fake_table(handler)
    cap = _breadth_cap()
    _parent_with_children_and_loose_rows(repo, repository, cap)

    try:
        repo.delete_category("coffee")
    except repository.InvalidCategoryParentError as e:
        raise AssertionError(
            f"a parent filled legally to the cap ({cap}) cannot be deleted at all: {e}") from None

    expression = repo._table.update_calls[-1][0]
    assert len(expression.encode()) <= _MAX_UPDATE_EXPRESSION_BYTES, (
        f"a parent filled to the cap ({cap}) builds a "
        f"{len(expression.encode())}-byte detach expression — DynamoDB would reject it")
    stored = repo._table.store[_CFG]["items"]
    assert "coffee" not in stored
    assert all(stored[f"kid{n:04d}"]["parent"] is None for n in range(cap))
    assert len(expression.encode()) < _MAX_UPDATE_EXPRESSION_BYTES // 2, (
        "the cap must leave headroom for the clause shape to grow, not sit on the line")


def test_the_delete_guard_refuses_exactly_when_one_more_clause_would_not_fit(handler):
    """[A2] The guard is now sized by the EXPRESSION, not by the child count (f631588), so
    the property to pin is tightness from both sides: the largest accepted parent really does
    write (FakeTable enforces the same 4096 the service does), and it sits within one clause
    of the ceiling — so the guard is not quietly refusing deletes that would have worked.
    The shipped 60-child test checks one point inside that range; this finds the edge itself.
    Also asserts the frontier is far above the breadth cap, which is what makes the cap a
    safety margin rather than a coincidence."""
    repository, repo = _repo_with_fake_table(handler)
    cap = _breadth_cap()
    frontier = _smallest_child_count_delete_refuses(handler)

    repository, repo = _repo_with_fake_table(handler)
    _parent_with_children(repo, repository, frontier - 1)
    repo.delete_category("coffee")                       # the largest parent still accepted

    expression = repo._table.update_calls[-1][0]
    slack = _MAX_UPDATE_EXPRESSION_BYTES - len(expression.encode())
    assert slack >= 0, "the guard let through an expression the service would reject"
    assert slack < 34, (
        f"{slack} spare bytes at the frontier — a whole extra detach clause still fits, so "
        f"the guard is refusing deletes that would have succeeded")
    assert frontier - 1 >= 2 * cap, (
        f"only {frontier - 1} children fit but the breadth cap is {cap} — the cap is no "
        f"longer a comfortable margin under the mechanical limit")


def test_a_full_parents_delete_fits_even_with_very_long_child_ids(handler):
    """[A11] The cap comment claims the per-child clause cost is independent of the id
    length, because only the #childN alias reaches the expression. If a refactor ever
    inlined the real id (`#items.groceries-sub-...`), 50 long-id children would blow the
    4KB cap and the cap value would be wrong — but every other test uses 7-char ids and
    would stay green."""
    repository, repo = _repo_with_fake_table(handler)
    cap = _breadth_cap()
    items = {cid: dict(seed) for cid, seed in repository.SEED_CATEGORIES.items()}
    for index in range(cap):
        long_id = f"{'x' * 200}{index:04d}"              # ids far longer than any slug
        items[long_id] = _cat(long_id, items["coffee"]["bucket"], parent="coffee")
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": items,
                               "version": Decimal(1), "colorSlotSchema": Decimal(1)}

    repo.delete_category("coffee")

    expression = repo._table.update_calls[-1][0]
    assert len(expression.encode()) <= _MAX_UPDATE_EXPRESSION_BYTES


# --- the cap under contention -----------------------------------------------


def test_the_loser_of_a_race_for_the_last_slot_is_refused_not_squeezed_in(handler):
    """[A3] The reason the check sits INSIDE create's retry loop. Both requests read a
    parent one short of the cap, so both pass validation; the winner takes the last slot and
    bumps the version, the loser's conditional write fails, and the retry must re-validate
    against the winner's tree. Hoist the check above `for _attempt in range(2)` and the
    parent silently ends up with cap+1 children — un-deletable, the original bug."""
    repository, repo = _repo_with_fake_table(handler)
    cap = _breadth_cap()
    _parent_with_children_and_loose_rows(repo, repository, cap - 1)

    def rival_takes_the_last_slot(item):
        item["items"]["rival"] = _cat("rival", item["items"]["coffee"]["bucket"],
                                      parent="coffee", **{_SLOT: Decimal(3)})
        item["version"] = item["version"] + 1

    repo._table.before_update.append(rival_takes_the_last_slot)

    with pytest.raises(repository.InvalidCategoryParentError, match="at most"):
        repo.create_category("wine", "Wine", "Lifestyle", "glass", parent="coffee")

    stored = repo._table.store[_CFG]["items"]
    assert "wine" not in stored
    assert sum(1 for c in stored.values() if c.get("parent") == "coffee") == cap


def test_the_loser_of_a_reparent_race_for_the_last_slot_is_refused_too(handler):
    """[A4] Same race on the OTHER write that adds a child link. update_category has its own
    retry loop; the breadth check has to be inside that one as well."""
    repository, repo = _repo_with_fake_table(handler)
    cap = _breadth_cap()
    items = _parent_with_children_and_loose_rows(repo, repository, cap - 1)
    items["loner"] = _cat("loner", "Lifestyle", parent=None, **{_SLOT: Decimal(7)})

    def rival_takes_the_last_slot(item):
        item["items"]["rival"] = _cat("rival", "Lifestyle", parent="coffee",
                                      **{_SLOT: Decimal(3)})
        item["version"] = item["version"] + 1

    repo._table.before_update.append(rival_takes_the_last_slot)

    with pytest.raises(repository.InvalidCategoryParentError, match="at most"):
        repo.update_category("loner", "Loner", "Lifestyle", "tag", parent="coffee")

    stored = repo._table.store[_CFG]["items"]
    assert stored["loner"].get("parent") is None
    assert sum(1 for c in stored.values() if c.get("parent") == "coffee") == cap


def test_a_plain_version_race_does_not_turn_a_legal_create_into_a_false_refusal(handler):
    """[A5] The mirror image, and the one that catches an over-eager fix: a retry that
    re-validates must still SUCCEED when the tree genuinely has room. A check that counted
    the pending child, or an off-by-one on retry, would 400 a perfectly legal create."""
    repository, repo = _repo_with_fake_table(handler)
    cap = _breadth_cap()
    _parent_with_children_and_loose_rows(repo, repository, cap - 1)
    repo._table.before_update.append(_bump_version)      # rival writes something unrelated

    created = repo.create_category("wine", "Wine", "Lifestyle", "glass", parent="coffee")

    assert created["parent"] == "coffee"
    stored = repo._table.store[_CFG]["items"]
    assert sum(1 for c in stored.values() if c.get("parent") == "coffee") == cap


def test_the_delete_guard_is_re_evaluated_on_the_retry_not_only_the_first_read(handler):
    """[A6] delete_category re-reads on a version race. If the guard were hoisted out of the
    loop it would be evaluated once, against the FIRST read — and a retry that re-reads an
    over-wide tree would go on to build the >4KB expression the card exists to prevent.
    Here the first read is exactly at the cap (legal) and the racing writer pushes it over,
    so only an inside-the-loop guard catches it."""
    repository, repo = _repo_with_fake_table(handler)
    cap = _breadth_cap()
    _parent_with_children_and_loose_rows(repo, repository, cap)

    def a_restore_widens_the_parent(item):
        for index in range(200):
            wide = f"restored{index:04d}"
            item["items"][wide] = _cat(wide, item["items"]["coffee"]["bucket"],
                                       parent="coffee")
        item["version"] = item["version"] + 1

    repo._table.before_update.append(a_restore_widens_the_parent)

    with pytest.raises(repository.InvalidCategoryParentError, match="move some out"):
        repo.delete_category("coffee")

    assert "coffee" in repo._table.store[_CFG]["items"]  # nothing half-done


def test_an_over_wide_delete_is_refused_before_any_write_is_attempted(handler):
    """[A7] The guard must be a pre-flight check, not a caught write failure: no
    UpdateExpression may be handed to DynamoDB at all. Catching the ValidationException
    after the fact would also produce a 400, but would burn a write and depend on parsing
    an AWS error message."""
    repository, repo = _repo_with_fake_table(handler)
    _parent_with_children(repo, repository, _UNDELETABLY_WIDE)
    repo._table.update_calls.clear()

    with pytest.raises(repository.InvalidCategoryParentError):
        repo.delete_category("coffee")

    assert repo._table.update_calls == []


# --- the no-op skip: is it an escape hatch? ---------------------------------


def test_the_no_op_skip_cannot_be_used_to_walk_a_parent_past_the_cap(handler):
    """[A8] The skip exists so re-saving an existing child is never blocked. The worry is
    that it becomes a back door: move a child out (parent now has room), then move TWO in.
    The second must still be refused — the skip only ever fires for a link that already
    exists, so it can never ADD one."""
    repository, repo = _repo_with_fake_table(handler)
    cap = _breadth_cap()
    items = _parent_with_children_and_loose_rows(repo, repository, cap)
    items["outsider"] = _cat("outsider", "Lifestyle", parent=None, **{_SLOT: Decimal(9)})

    repo.update_category("kid0000", "Kid Zero", "Lifestyle", "tag", parent=None)   # -> cap-1
    repo.update_category("kid0000", "Kid Zero", "Lifestyle", "tag", parent="coffee")  # -> cap

    with pytest.raises(repository.InvalidCategoryParentError, match="at most"):
        repo.update_category("outsider", "Outsider", "Lifestyle", "tag", parent="coffee")

    stored = repo._table.store[_CFG]["items"]
    assert sum(1 for c in stored.values() if c.get("parent") == "coffee") == cap
    assert stored["outsider"].get("parent") is None


def test_a_child_that_leaves_an_over_wide_legacy_parent_can_never_move_back(handler):
    """[A9] The deliberate one-way door on grandfathered data: an over-cap parent may only
    shrink. Pinning it stops a later 'be lenient to legacy trees' tweak from letting an
    un-deletable parent re-grow after the user has done the work of shrinking it."""
    repository, repo = _repo_with_fake_table(handler)
    cap = _breadth_cap()
    _parent_with_children_and_loose_rows(repo, repository, cap + 10)

    repo.update_category("kid0000", "Kid Zero", "Lifestyle", "tag", parent=None)

    with pytest.raises(repository.InvalidCategoryParentError, match="at most"):
        repo.update_category("kid0000", "Kid Zero", "Lifestyle", "tag", parent="coffee")

    stored = repo._table.store[_CFG]["items"]
    assert stored["kid0000"].get("parent") is None
    assert sum(1 for c in stored.values() if c.get("parent") == "coffee") == cap + 9


# --- the branches deliberately left unchecked -------------------------------


def test_a_plain_edit_of_a_child_of_an_over_wide_parent_is_never_blocked(handler):
    """[A10] The false-refusal guard for the branch that is deliberately NOT breadth-checked
    (`not changing_parent`). A user stuck with a grandfathered 60-child parent must still be
    able to rename and re-icon its children while shrinking it — otherwise the cap traps
    them. Also proves the write carries no parent clause, so this branch cannot grow the
    parent it skipped the check for."""
    repository, repo = _repo_with_fake_table(handler)
    _parent_with_children_and_loose_rows(repo, repository, _breadth_cap() + 10)
    before = sum(1 for c in repo._table.store[_CFG]["items"].values()
                 if c.get("parent") == "coffee")
    repo._table.update_calls.clear()

    updated = repo.update_category("kid0003", "Renamed", "Lifestyle", "cart")

    assert updated["name"] == "Renamed" and updated["icon"] == "cart"
    expression = repo._table.update_calls[-1][0]
    assert "#items.#id.#parent" not in expression, \
        "a parent-less edit must not write a parent link"
    stored = repo._table.store[_CFG]["items"]
    assert stored["kid0003"]["parent"] == "coffee"       # link untouched, not wiped
    assert sum(1 for c in stored.values() if c.get("parent") == "coffee") == before


def test_top_level_categories_are_not_capped(handler):
    """[A12] Only a PARENT's children are capped. Nothing in delete_category detaches a
    top-level row, so top-level breadth costs nothing — and capping it would be a false
    refusal for the flat taxonomy most users actually have. Reddens if the breadth check is
    ever hoisted out of `if parent is not None`, where parent_id=None would count every
    top-level category."""
    repository, repo = _repo_with_fake_table(handler)
    cap = _breadth_cap()
    _parent_with_children_and_loose_rows(repo, repository, 0, extra_top_level=cap + 5)

    created = repo.create_category("gym", "Gym", "Lifestyle", "dumbbell")

    assert created["parent"] is None
    assert "gym" in repo._table.store[_CFG]["items"]


def test_breadth_counts_direct_children_only_not_the_whole_subtree(handler):
    """[A13] delete_category detaches DIRECT children only, so that is what the cap must
    count. A descendant-count implementation would pass every shipped test (they are all one
    level deep) while falsely refusing a legal shallow-and-wide-below tree."""
    repository, repo = _repo_with_fake_table(handler)
    cap = _breadth_cap()
    items = {cid: dict(seed) for cid, seed in repository.SEED_CATEGORIES.items()}
    items["mid"] = _cat("mid", items["coffee"]["bucket"], parent="coffee")
    for index in range(cap):                             # cap GRANDchildren under coffee
        gc = f"gc{index:04d}"
        items[gc] = _cat(gc, items["coffee"]["bucket"], parent="mid")
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": items,
                               "version": Decimal(1), "colorSlotSchema": Decimal(1)}

    repository.validate_category_breadth(items, "new", "coffee")   # 1 direct child: fine

    created = repo.create_category("wine", "Wine", "Lifestyle", "glass", parent="coffee")
    assert created["parent"] == "coffee"


def test_depth_is_reported_before_breadth_when_a_create_breaks_both(handler):
    """[A15] Error precedence: parent -> depth -> breadth. A category that is both too deep
    and under a full parent must name the depth problem, because moving it shallower is the
    fix the user can act on; 'too many sub-categories' would send them to shrink a parent
    they then still could not nest under."""
    repository, repo = _repo_with_fake_table(handler)
    cap = _breadth_cap()
    items = {cid: dict(seed) for cid, seed in repository.SEED_CATEGORIES.items()}
    bucket = items["coffee"]["bucket"]
    chain = ["coffee", "lvl2", "lvl3", "lvl4", "lvl5"]
    for depth, cat_id in enumerate(chain[1:], start=1):
        items[cat_id] = _cat(cat_id, bucket, parent=chain[depth - 1])
    for index in range(cap):                             # lvl5 is BOTH too deep AND full
        kid = f"deepkid{index:04d}"
        items[kid] = _cat(kid, bucket, parent="lvl5")
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": items,
                               "version": Decimal(1), "colorSlotSchema": Decimal(1)}

    with pytest.raises(repository.InvalidCategoryParentError, match="levels deep"):
        repo.create_category("toodeep", "Too Deep", bucket, "tag", parent="lvl5")

    # ...and a non-existent parent still beats both.
    with pytest.raises(repository.InvalidCategoryParentError, match="does not exist"):
        repo.create_category("ghost", "Ghost", bucket, "tag", parent="nope")


# --- is the 400 actually actionable? ----------------------------------------


def test_the_delete_400_names_a_fix_the_user_can_actually_carry_out(handler):
    """[A16] A 400 is only better than a 500 if the advice works. Take a parent three
    children past the frontier, do exactly what the message says — move some out from under
    it — and the same DELETE must then succeed. If detaching were itself blocked, or the
    guard were off by one, the user would be stuck in a loop with an undeletable category and
    no error that told them so."""
    repository, repo = _repo_with_fake_table(handler)
    frontier = _smallest_child_count_delete_refuses(handler)
    repository, repo = _repo_with_fake_table(handler)
    _parent_with_children(repo, repository, frontier + 2)
    event = _category_item_event("DELETE", body=None)

    refused = handler.delete_category(event, repo, FakeBudgetRepo())
    assert refused["statusCode"] == 400
    message = json.loads(refused["body"])["error"]
    assert "coffee" in message and "move some out" in message

    for index in range(3):                               # do exactly what the message says
        moved = handler.update_category(
            _category_item_event("PATCH", cat_id=f"kid{index:04d}",
                                 body=json.dumps({"name": f"Kid {index}",
                                                  "bucket": "Lifestyle",
                                                  "parent": None})),
            repo, FakeBudgetRepo())
        assert moved["statusCode"] == 200, moved["body"]

    allowed = handler.delete_category(event, repo, FakeBudgetRepo())

    assert allowed["statusCode"] == 200
    stored = repo._table.store[_CFG]["items"]
    assert "coffee" not in stored
    assert all(stored[f"kid{n:04d}"]["parent"] is None for n in range(frontier + 2))


def test_a_refused_delete_does_not_cascade_delete_the_budget(handler):
    """[A17] Failure honesty. delete_category cascades a budget delete after the category is
    gone; a refused delete must not run the cascade, or the user would lose the target of a
    category that is still there. The 400 is raised before the cascade — pin it."""
    repository, repo = _repo_with_fake_table(handler)
    _parent_with_children(repo, repository, _UNDELETABLY_WIDE)
    budgets = FakeBudgetRepo(budgets={"coffee": {"target": Decimal(100)}})

    resp = handler.delete_category(_category_item_event("DELETE", body=None), repo, budgets)

    assert resp["statusCode"] == 400
    assert budgets.delete_calls == []


def test_the_create_and_reparent_refusals_reach_the_client_as_400s(handler):
    """[A18] The end-to-end wiring for the two writes the cap actually guards. The shipped
    handler test covers DELETE only, so a lost `except InvalidCategoryParentError` on POST
    or PATCH would ship a 500 with every repository test still green."""
    repository, repo = _repo_with_fake_table(handler)
    cap = _breadth_cap()
    items = _parent_with_children_and_loose_rows(repo, repository, cap)
    items["loner"] = _cat("loner", "Lifestyle", parent=None, **{_SLOT: Decimal(11)})

    posted = handler.create_category(
        _categories_event(json.dumps({"name": "Wine", "bucket": "Lifestyle",
                                      "icon": "glass", "parent": "coffee"})),
        repo, FakeBudgetRepo())
    assert posted["statusCode"] == 400
    assert "sub-categories" in json.loads(posted["body"])["error"]

    patched = handler.update_category(
        _category_item_event("PATCH", cat_id="loner",
                             body=json.dumps({"name": "Loner", "bucket": "Lifestyle",
                                              "parent": "coffee"})),
        repo, FakeBudgetRepo())
    assert patched["statusCode"] == 400
    assert "sub-categories" in json.loads(patched["body"])["error"]


def test_the_extracted_no_op_skip_did_not_leak_into_the_bucket_rule(handler):
    """[A19] f631588 pulled the no-op-re-parent predicate out of the depth and breadth
    validators into one shared `_is_a_no_op_reparent`. validate_category_parent deliberately
    has NO such skip: a category resubmitted under its existing parent must still be
    bucket-checked, or a plain edit could silently move a sub into a bucket its parent isn't
    in. Reddens if the shared helper is ever wired into the parent validator too."""
    repository, repo = _repo_with_fake_table(handler)
    _parent_with_children(repo, repository, 3)           # kid000x sit under Lifestyle coffee

    with pytest.raises(repository.InvalidCategoryParentError, match="same bucket"):
        repo.update_category("kid0000", "Kid Zero", "Living", "tag", parent="coffee")

    assert repo._table.store[_CFG]["items"]["kid0000"]["bucket"] == "Lifestyle"
