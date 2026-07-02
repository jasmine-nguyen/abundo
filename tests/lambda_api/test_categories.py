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

from botocore.exceptions import ClientError


# --- handler-level fake ------------------------------------------------------


class FakeCategoryRepo:
    """Handler-level stand-in for CategoryRepository (records calls)."""

    def __init__(self, categories=None, duplicate_exc=None, not_found_exc=None):
        self._categories = categories or []
        self._duplicate_exc = duplicate_exc
        self._not_found_exc = not_found_exc
        self.create_calls = []
        self.update_calls = []
        self.delete_calls = []
        self.list_calls = 0

    def list_categories(self):
        self.list_calls += 1
        return [dict(c) for c in self._categories]

    def create_category(self, cat_id, name, bucket, icon):
        self.create_calls.append((cat_id, name, bucket, icon))
        if self._duplicate_exc is not None:
            raise self._duplicate_exc(cat_id)
        return {"id": cat_id, "name": name, "icon": icon, "color": "#123456", "bucket": bucket}

    def update_category(self, cat_id, name, bucket, icon):
        self.update_calls.append((cat_id, name, bucket, icon))
        if self._not_found_exc is not None:
            raise self._not_found_exc(cat_id)
        return {"id": cat_id, "name": name, "icon": icon, "color": "#123456", "bucket": bucket}

    def delete_category(self, cat_id):
        self.delete_calls.append(cat_id)
        if self._not_found_exc is not None:
            raise self._not_found_exc(cat_id)
        return cat_id


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

    resp = handler.create_category(_categories_event(), repo)

    assert resp["statusCode"] == 201
    body = json.loads(resp["body"])
    assert body["id"] == "gym" and body["bucket"] == "Lifestyle" and body["recent"] == 0
    assert repo.create_calls == [("gym", "Gym", "Lifestyle", "dumbbell")]


def test_create_slugifies_multiword_name(handler):
    repo = FakeCategoryRepo()

    resp = handler.create_category(
        _categories_event('{"name": "Gym Membership!", "bucket": "Living", "icon": "dumbbell"}'), repo)

    assert resp["statusCode"] == 201
    assert repo.create_calls[0][0] == "gymmembership"


def test_create_icon_optional_defaults(handler):
    repo = FakeCategoryRepo()

    resp = handler.create_category(_categories_event('{"name": "Gym", "bucket": "Living"}'), repo)

    assert resp["statusCode"] == 201
    assert repo.create_calls[0][3] == "tag"  # DEFAULT_CATEGORY_ICON


def test_create_invalid_bucket_400(handler):
    repo = FakeCategoryRepo()

    resp = handler.create_category(
        _categories_event('{"name": "Gym", "bucket": "Fun", "icon": "x"}'), repo)

    assert resp["statusCode"] == 400
    assert repo.create_calls == []


def test_create_missing_name_400(handler):
    repo = FakeCategoryRepo()

    resp = handler.create_category(_categories_event('{"bucket": "Living", "icon": "x"}'), repo)

    assert resp["statusCode"] == 400
    assert repo.create_calls == []


def test_create_empty_slug_400(handler):
    # non-empty name, but no slug-safe characters -> empty id -> 400
    repo = FakeCategoryRepo()

    resp = handler.create_category(
        _categories_event('{"name": "!!!", "bucket": "Living", "icon": "x"}'), repo)

    assert resp["statusCode"] == 400
    assert repo.create_calls == []


def test_create_duplicate_409(handler):
    repo = FakeCategoryRepo(duplicate_exc=handler.DuplicateCategoryError)

    resp = handler.create_category(_categories_event(), repo)

    assert resp["statusCode"] == 409


def test_create_invalid_json_400(handler):
    repo = FakeCategoryRepo()

    resp = handler.create_category(_categories_event("not json"), repo)

    assert resp["statusCode"] == 400
    assert repo.create_calls == []


def test_create_base64_body(handler):
    repo = FakeCategoryRepo()
    encoded = base64.b64encode(b'{"name": "Gym", "bucket": "Living", "icon": "dumbbell"}').decode()

    resp = handler.create_category(_categories_event(body=encoded, is_b64=True), repo)

    assert resp["statusCode"] == 201
    assert repo.create_calls == [("gym", "Gym", "Living", "dumbbell")]


def test_post_categories_dispatch(handler, monkeypatch):
    repo = FakeCategoryRepo()
    monkeypatch.setattr(handler, "CategoryRepository", lambda: repo)

    resp = handler.lambda_handler(_categories_event(), None)

    assert resp["statusCode"] == 201
    assert repo.create_calls == [("gym", "Gym", "Lifestyle", "dumbbell")]


# --- repository-level: storage logic via an in-memory fake table -------------


# --- handler-level: PATCH /categories/{id} (update) --------------------------


def test_update_success(handler):
    repo = FakeCategoryRepo()

    resp = handler.update_category(_category_item_event("PATCH"), repo)

    assert resp["statusCode"] == 200
    body = json.loads(resp["body"])
    assert body["name"] == "Coffee & Cake" and body["id"] == "coffee" and body["recent"] == 0
    assert repo.update_calls == [("coffee", "Coffee & Cake", "Living", "coffee")]


def test_update_missing_id_returns_404(handler):
    repo = FakeCategoryRepo()
    event = _category_item_event("PATCH")
    event["pathParameters"] = {}

    resp = handler.update_category(event, repo)

    assert resp["statusCode"] == 404
    assert repo.update_calls == []


def test_update_blank_name_returns_400(handler):
    repo = FakeCategoryRepo()

    resp = handler.update_category(
        _category_item_event("PATCH", body='{"name": "   ", "bucket": "Living"}'), repo)

    assert resp["statusCode"] == 400
    assert repo.update_calls == []


def test_update_invalid_bucket_returns_400(handler):
    repo = FakeCategoryRepo()

    resp = handler.update_category(
        _category_item_event("PATCH", body='{"name": "Coffee", "bucket": "Fun"}'), repo)

    assert resp["statusCode"] == 400
    assert repo.update_calls == []


def test_update_invalid_json_returns_400(handler):
    repo = FakeCategoryRepo()

    resp = handler.update_category(_category_item_event("PATCH", body="not json"), repo)

    assert resp["statusCode"] == 400
    assert repo.update_calls == []


def test_update_icon_optional_defaults(handler):
    repo = FakeCategoryRepo()

    resp = handler.update_category(
        _category_item_event("PATCH", body='{"name": "Coffee", "bucket": "Living"}'), repo)

    assert resp["statusCode"] == 200
    assert repo.update_calls[0][3] == "tag"  # DEFAULT_CATEGORY_ICON


def test_update_unknown_id_returns_404(handler):
    repo = FakeCategoryRepo(not_found_exc=handler.CategoryNotFoundError)

    resp = handler.update_category(_category_item_event("PATCH"), repo)

    assert resp["statusCode"] == 404


def test_update_dispatch(handler, monkeypatch):
    repo = FakeCategoryRepo()
    monkeypatch.setattr(handler, "CategoryRepository", lambda: repo)

    resp = handler.lambda_handler(_category_item_event("PATCH"), None)

    assert resp["statusCode"] == 200
    assert repo.update_calls == [("coffee", "Coffee & Cake", "Living", "coffee")]


# --- handler-level: DELETE /categories/{id} ----------------------------------


def test_delete_success(handler):
    repo = FakeCategoryRepo()

    resp = handler.delete_category(_category_item_event("DELETE", body=None), repo)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"id": "coffee"}
    assert repo.delete_calls == ["coffee"]


def test_delete_missing_id_returns_404(handler):
    repo = FakeCategoryRepo()
    event = _category_item_event("DELETE", body=None)
    event["pathParameters"] = {}

    resp = handler.delete_category(event, repo)

    assert resp["statusCode"] == 404
    assert repo.delete_calls == []


def test_delete_unknown_id_returns_404(handler):
    repo = FakeCategoryRepo(not_found_exc=handler.CategoryNotFoundError)

    resp = handler.delete_category(_category_item_event("DELETE", body=None), repo)

    assert resp["statusCode"] == 404


def test_delete_dispatch(handler, monkeypatch):
    repo = FakeCategoryRepo()
    monkeypatch.setattr(handler, "CategoryRepository", lambda: repo)

    resp = handler.lambda_handler(_category_item_event("DELETE", body=None), None)

    assert resp["statusCode"] == 200
    assert repo.delete_calls == ["coffee"]


def _ccfe():
    err = ClientError()
    err.response = {"Error": {"Code": "ConditionalCheckFailedException"}}
    return err


class FakeTable:
    """In-memory table emulating only the calls CategoryRepository makes:
    get_item, conditional put_item, and the nested conditional update_item."""

    def __init__(self):
        self.store = {}  # (pk, sk) -> item
        # Queue of callables(item) run just before each update_item evaluation,
        # to simulate a concurrent writer mutating the row between read and write.
        self.before_update = []

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
        cat_id = ExpressionAttributeNames["#id"]
        values = ExpressionAttributeValues

        # attribute_exists(pk) AND #v = :expected are common to create/rename/delete.
        if item is None or item["version"] != values[":expected"]:
            raise _ccfe()

        if UpdateExpression.startswith("REMOVE"):
            # delete: guard attribute_exists(items.<id>)
            if cat_id not in item["items"]:
                raise _ccfe()
            del item["items"][cat_id]
        elif "#items.#id.#name" in UpdateExpression:
            # update: guard attribute_exists(items.<id>); sets name, bucket, icon
            if cat_id not in item["items"]:
                raise _ccfe()
            item["items"][cat_id]["name"] = values[":name"]
            item["items"][cat_id]["bucket"] = values[":bucket"]
            item["items"][cat_id]["icon"] = values[":icon"]
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
        assert False, "expected RuntimeError under sustained contention"
    except RuntimeError:
        pass


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
    assert updated == {"id": "coffee", "name": "Coffee & Cake", "icon": "cart",
                       "color": "#E8A87C", "bucket": "Living"}


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
