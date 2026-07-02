"""Tests for the pay-cycle endpoints (GET /paycycle, PUT /paycycle) and
PayCycleRepository.

Handler-level tests inject a FakePayCycleRepo directly (no patching). Repository
tests inject a tiny in-memory fake DynamoDB table into PayCycleRepository. Unlike
BudgetRepository the pay cycle is one settings object, not a per-key `items` map,
so the write REPLACES both `length` and `anchor` together under the version guard
— the fake table's update branch reflects that.

The `handler` fixture (conftest.py) makes lambda_api importable in isolation and
puts `shared/` on the path, so `import repository` inside a test resolves to
shared/repository.py with boto3/botocore already faked.
"""

import json
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from botocore.exceptions import ClientError


def _today_utc():
    return datetime.now(timezone.utc).date()


# --- handler-level fake ------------------------------------------------------


class FakePayCycleRepo:
    """Handler-level stand-in for PayCycleRepository (records calls)."""

    def __init__(self, cycle=None, conflict_exc=None):
        self._cycle = cycle or {"length": 14, "anchor": "2024-01-03"}
        self._conflict_exc = conflict_exc
        self.set_calls = []
        self.get_calls = 0

    def get_paycycle(self):
        self.get_calls += 1
        return dict(self._cycle)

    def set_paycycle(self, length, anchor):
        self.set_calls.append((length, anchor))
        if self._conflict_exc is not None:
            raise self._conflict_exc("boom")
        return {"length": length, "anchor": anchor}


def _put_paycycle_event(body='{"length": 7, "anchor": "2024-06-05"}', is_b64=False):
    return {
        "rawPath": "/paycycle",
        "requestContext": {"http": {"method": "PUT"}},
        "body": body,
        "isBase64Encoded": is_b64,
    }


# --- handler-level: PUT /paycycle --------------------------------------------


def test_set_paycycle_success(handler):
    repo = FakePayCycleRepo()

    resp = handler.set_paycycle(_put_paycycle_event(), repo)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"length": 7, "anchor": "2024-06-05"}
    assert repo.set_calls == [(7, "2024-06-05")]


def test_set_paycycle_anchor_today_accepted(handler):
    # A payday of "today" is valid (only the future is rejected).
    repo = FakePayCycleRepo()
    body = json.dumps({"length": 14, "anchor": _today_utc().isoformat()})

    resp = handler.set_paycycle(_put_paycycle_event(body=body), repo)

    assert resp["statusCode"] == 200
    assert repo.set_calls == [(14, _today_utc().isoformat())]


def test_set_paycycle_anchor_at_future_ceiling_accepted(handler):
    # The ceiling is today + 1 day (AEST-runs-ahead-of-UTC slack); exactly that is OK.
    repo = FakePayCycleRepo()
    body = json.dumps({"length": 30, "anchor": (_today_utc() + timedelta(days=1)).isoformat()})

    resp = handler.set_paycycle(_put_paycycle_event(body=body), repo)

    assert resp["statusCode"] == 200


def test_set_paycycle_future_anchor_400(handler):
    repo = FakePayCycleRepo()
    body = json.dumps({"length": 14, "anchor": (_today_utc() + timedelta(days=5)).isoformat()})

    resp = handler.set_paycycle(_put_paycycle_event(body=body), repo)

    assert resp["statusCode"] == 400
    assert repo.set_calls == []


def test_set_paycycle_bad_length_400(handler):
    repo = FakePayCycleRepo()
    body = json.dumps({"length": 10, "anchor": "2024-06-05"})

    resp = handler.set_paycycle(_put_paycycle_event(body=body), repo)

    assert resp["statusCode"] == 400
    assert repo.set_calls == []


def test_set_paycycle_bool_length_400(handler):
    # bool is an int subclass -> must be rejected before the membership check.
    repo = FakePayCycleRepo()
    body = json.dumps({"length": True, "anchor": "2024-06-05"})

    resp = handler.set_paycycle(_put_paycycle_event(body=body), repo)

    assert resp["statusCode"] == 400


def test_set_paycycle_missing_length_400(handler):
    repo = FakePayCycleRepo()
    body = json.dumps({"anchor": "2024-06-05"})

    resp = handler.set_paycycle(_put_paycycle_event(body=body), repo)

    assert resp["statusCode"] == 400


def test_set_paycycle_missing_anchor_400(handler):
    repo = FakePayCycleRepo()
    body = json.dumps({"length": 14})

    resp = handler.set_paycycle(_put_paycycle_event(body=body), repo)

    assert resp["statusCode"] == 400


def test_set_paycycle_non_string_anchor_400(handler):
    repo = FakePayCycleRepo()
    body = json.dumps({"length": 14, "anchor": 20240605})

    resp = handler.set_paycycle(_put_paycycle_event(body=body), repo)

    assert resp["statusCode"] == 400


def test_set_paycycle_malformed_anchor_400(handler):
    repo = FakePayCycleRepo()
    body = json.dumps({"length": 14, "anchor": "05/06/2024"})

    resp = handler.set_paycycle(_put_paycycle_event(body=body), repo)

    assert resp["statusCode"] == 400
    assert repo.set_calls == []


def test_set_paycycle_invalid_json_400(handler):
    repo = FakePayCycleRepo()

    resp = handler.set_paycycle(_put_paycycle_event(body="not json"), repo)

    assert resp["statusCode"] == 400


def test_set_paycycle_base64_body(handler):
    import base64
    repo = FakePayCycleRepo()
    raw = base64.b64encode(b'{"length": 30, "anchor": "2024-06-05"}').decode()

    resp = handler.set_paycycle(_put_paycycle_event(body=raw, is_b64=True), repo)

    assert resp["statusCode"] == 200
    assert repo.set_calls == [(30, "2024-06-05")]


# --- dispatch through lambda_handler -----------------------------------------


def test_get_paycycle_dispatch(handler, monkeypatch):
    repo = FakePayCycleRepo(cycle={"length": 14, "anchor": "2024-01-03"})
    monkeypatch.setattr(handler, "PayCycleRepository", lambda: repo)

    resp = handler.lambda_handler({
        "rawPath": "/paycycle",
        "requestContext": {"http": {"method": "GET"}},
    }, None)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"length": 14, "anchor": "2024-01-03"}
    assert repo.get_calls == 1


def test_put_paycycle_dispatch(handler, monkeypatch):
    repo = FakePayCycleRepo()
    monkeypatch.setattr(handler, "PayCycleRepository", lambda: repo)

    resp = handler.lambda_handler(_put_paycycle_event(), None)

    assert resp["statusCode"] == 200
    assert repo.set_calls == [(7, "2024-06-05")]


def test_unknown_paycycle_method_falls_through_404(handler, monkeypatch):
    # DELETE /paycycle isn't a route -> catch-all 404.
    monkeypatch.setattr(handler, "PayCycleRepository", lambda: FakePayCycleRepo())

    resp = handler.lambda_handler({
        "rawPath": "/paycycle",
        "requestContext": {"http": {"method": "DELETE"}},
    }, None)

    assert resp["statusCode"] == 404


def test_set_paycycle_conflict_returns_409(handler, monkeypatch):
    # A repo that exhausts its retry budget raises VersionConflictError; the shared
    # dispatch wrapper maps it to 409.
    repo = FakePayCycleRepo(conflict_exc=handler.VersionConflictError)
    monkeypatch.setattr(handler, "PayCycleRepository", lambda: repo)

    resp = handler.lambda_handler(_put_paycycle_event(), None)

    assert resp["statusCode"] == 409


# --- repository-level: storage logic via an in-memory fake table -------------


def _ccfe():
    err = ClientError()
    err.response = {"Error": {"Code": "ConditionalCheckFailedException"}}
    return err


class FakePayCycleTable:
    """In-memory table emulating the calls PayCycleRepository makes: get_item,
    conditional seed put_item, and the whole-object update_item (SET length,
    anchor, version under the version guard)."""

    def __init__(self):
        self.store = {}  # (pk, sk) -> item
        # Queue of callables(item) run just before each update_item evaluation,
        # to simulate a concurrent writer mutating the row between read and write.
        self.before_update = []

    def get_item(self, Key):
        import copy
        item = self.store.get((Key["pk"], Key["sk"]))
        return {"Item": copy.deepcopy(item)} if item is not None else {}

    def put_item(self, Item, ConditionExpression=None):
        import copy
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

        # attribute_exists(pk) AND #v = :expected — the optimistic-lock guard.
        if item is None or item["version"] != values[":expected"]:
            raise _ccfe()

        item["length"] = values[":length"]
        item["anchor"] = values[":anchor"]
        item["version"] = values[":next"]


def _repo_with_fake_table(handler):
    import repository
    repo = repository.PayCycleRepository()
    repo._table = FakePayCycleTable()
    return repository, repo


def test_repo_get_paycycle_seeds_default_then_stable(handler):
    repository, repo = _repo_with_fake_table(handler)

    first = repo.get_paycycle()
    second = repo.get_paycycle()  # must not re-seed

    assert first == {"length": 14, "anchor": "2024-01-03"}
    assert second == first
    config = repo._table.store[("PAYCYCLE", "PAYCYCLE")]
    assert config["version"] == 1


def test_repo_get_paycycle_returns_int_length(handler):
    # DynamoDB stores numbers as Decimal; the API must serialise length as an int.
    repository, repo = _repo_with_fake_table(handler)

    cycle = repo.get_paycycle()

    assert isinstance(cycle["length"], int)


def test_repo_set_paycycle_writes(handler):
    repository, repo = _repo_with_fake_table(handler)

    saved = repo.set_paycycle(7, "2024-06-05")

    config = repo._table.store[("PAYCYCLE", "PAYCYCLE")]
    assert config["length"] == Decimal(7)
    assert config["anchor"] == "2024-06-05"
    assert config["version"] == 2
    assert saved == {"length": 7, "anchor": "2024-06-05"}


def test_repo_set_paycycle_replaces_both_fields(handler):
    repository, repo = _repo_with_fake_table(handler)

    repo.set_paycycle(7, "2024-06-05")
    repo.set_paycycle(30, "2024-06-30")

    config = repo._table.store[("PAYCYCLE", "PAYCYCLE")]
    assert config["length"] == Decimal(30)
    assert config["anchor"] == "2024-06-30"
    assert config["version"] == 3


def _bump_version(item):
    item["version"] = item["version"] + 1  # Decimal + int -> Decimal


def test_repo_set_paycycle_retries_after_version_race(handler):
    repository, repo = _repo_with_fake_table(handler)
    repo._table.before_update.append(_bump_version)

    repo.set_paycycle(7, "2024-06-05")

    config = repo._table.store[("PAYCYCLE", "PAYCYCLE")]
    assert config["length"] == Decimal(7)
    assert config["version"] == 3  # seed(1) + concurrent bump(->2) + our write(->3)


def test_repo_set_paycycle_raises_under_sustained_contention(handler):
    # Every attempt sees a fresh version bump -> never converges -> 409.
    repository, repo = _repo_with_fake_table(handler)
    repo._table.before_update.extend([_bump_version, _bump_version])

    try:
        repo.set_paycycle(7, "2024-06-05")
        assert False, "expected VersionConflictError under sustained contention"
    except repository.VersionConflictError:
        pass
