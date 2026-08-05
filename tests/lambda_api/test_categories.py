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
import json
from decimal import Decimal

import pytest

# The shared category fakes and store builders live in one module (tests/shared); the
# call-time `import repository` inside these still runs under the `handler` fixture.
# (The colorSlot fakes moved to test_category_color_slots.py with their tests — WHIT-462.)
from _category_fakes import (
    FakeTable, FakeBudgetRepo, _MAX_UPDATE_EXPRESSION_BYTES,
    _CFG, _SLOT, _cat, _categories_event, _repo_with_fake_table,
)


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
