"""Tests for the budget-target endpoints (GET /budgets, PUT /budgets/{category})
and BudgetRepository.

Handler-level tests inject a FakeBudgetRepo directly (no patching). Repository
tests inject a tiny in-memory fake DynamoDB table into BudgetRepository. The
budget write is an idempotent UPSERT (`SET #items.#id = :val`, no exists guard),
so the fake table's update branch differs from the category one — setting the
same category's target twice must overwrite, never raise.

The `handler` fixture (conftest.py) makes lambda_api importable in isolation and
puts `shared/` on the path, so `import repository` inside a test resolves to
shared/repository.py with boto3/botocore already faked.
"""

import base64
import copy
import json
from decimal import Decimal

from botocore.exceptions import ClientError


# --- handler-level fake ------------------------------------------------------


class FakeBudgetRepo:
    """Handler-level stand-in for BudgetRepository (records calls)."""

    def __init__(self, budgets=None, conflict_exc=None):
        # budgets: {id: {"target": Decimal}} (the stored/nested shape).
        self._budgets = budgets or {}
        self._conflict_exc = conflict_exc
        self.set_calls = []
        self.list_calls = 0

    def list_budgets(self):
        self.list_calls += 1
        return {k: dict(v) for k, v in self._budgets.items()}

    def set_budget(self, cat_id, target):
        self.set_calls.append((cat_id, target))
        if self._conflict_exc is not None:
            raise self._conflict_exc("boom")
        return {"id": cat_id, "target": target}


def _put_budget_event(category="coffee", body='{"target": 58}', is_b64=False):
    return {
        "rawPath": f"/budgets/{category}",
        "requestContext": {"http": {"method": "PUT"}},
        "pathParameters": {"category": category},
        "body": body,
        "isBase64Encoded": is_b64,
    }


# --- handler-level: PUT /budgets/{category} ----------------------------------


def test_set_budget_success(handler):
    repo = FakeBudgetRepo()

    resp = handler.set_budget(_put_budget_event(), repo)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"id": "coffee", "target": 58}
    assert repo.set_calls == [("coffee", Decimal("58"))]


def test_set_budget_zero_accepted(handler):
    repo = FakeBudgetRepo()

    resp = handler.set_budget(_put_budget_event(body='{"target": 0}'), repo)

    assert resp["statusCode"] == 200
    assert repo.set_calls == [("coffee", Decimal("0"))]


def test_set_budget_decimal_precision(handler):
    # Decimal(str(12.34)) stores exactly, never binary-float drift.
    repo = FakeBudgetRepo()

    resp = handler.set_budget(_put_budget_event(body='{"target": 12.34}'), repo)

    assert resp["statusCode"] == 200
    assert repo.set_calls == [("coffee", Decimal("12.34"))]


def test_set_budget_unknown_category_accepted(handler):
    # Unknown ids are accepted (stored as an orphan the client ignores).
    repo = FakeBudgetRepo()

    resp = handler.set_budget(_put_budget_event(category="doesnotexist"), repo)

    assert resp["statusCode"] == 200
    assert repo.set_calls == [("doesnotexist", Decimal("58"))]


def test_set_budget_missing_target_400(handler):
    repo = FakeBudgetRepo()

    resp = handler.set_budget(_put_budget_event(body='{"note": "x"}'), repo)

    assert resp["statusCode"] == 400
    assert repo.set_calls == []


def test_set_budget_string_target_400(handler):
    repo = FakeBudgetRepo()

    resp = handler.set_budget(_put_budget_event(body='{"target": "58"}'), repo)

    assert resp["statusCode"] == 400
    assert repo.set_calls == []


def test_set_budget_bool_target_400(handler):
    # bool is an int subclass; must be rejected, not treated as 1/0.
    repo = FakeBudgetRepo()

    resp = handler.set_budget(_put_budget_event(body='{"target": true}'), repo)

    assert resp["statusCode"] == 400
    assert repo.set_calls == []


def test_set_budget_negative_400(handler):
    repo = FakeBudgetRepo()

    resp = handler.set_budget(_put_budget_event(body='{"target": -5}'), repo)

    assert resp["statusCode"] == 400
    assert repo.set_calls == []


def test_set_budget_nan_400(handler):
    # json.loads accepts the NaN token; must be rejected before hitting DynamoDB.
    repo = FakeBudgetRepo()

    resp = handler.set_budget(_put_budget_event(body='{"target": NaN}'), repo)

    assert resp["statusCode"] == 400
    assert repo.set_calls == []


def test_set_budget_infinity_400(handler):
    repo = FakeBudgetRepo()

    resp = handler.set_budget(_put_budget_event(body='{"target": Infinity}'), repo)

    assert resp["statusCode"] == 400
    assert repo.set_calls == []


def test_set_budget_too_large_400(handler):
    # A value past the sane ceiling is bad input (400), not a write-time 500.
    repo = FakeBudgetRepo()

    resp = handler.set_budget(_put_budget_event(body='{"target": 1e40}'), repo)

    assert resp["statusCode"] == 400
    assert repo.set_calls == []


def test_set_budget_missing_path_param_404(handler):
    repo = FakeBudgetRepo()
    event = _put_budget_event()
    event["pathParameters"] = {}

    resp = handler.set_budget(event, repo)

    assert resp["statusCode"] == 404
    assert repo.set_calls == []


def test_set_budget_invalid_json_400(handler):
    repo = FakeBudgetRepo()

    resp = handler.set_budget(_put_budget_event(body="not json"), repo)

    assert resp["statusCode"] == 400
    assert repo.set_calls == []


def test_set_budget_base64_body(handler):
    repo = FakeBudgetRepo()
    encoded = base64.b64encode(b'{"target": 58}').decode()

    resp = handler.set_budget(_put_budget_event(body=encoded, is_b64=True), repo)

    assert resp["statusCode"] == 200
    assert repo.set_calls == [("coffee", Decimal("58"))]


# --- handler-level: GET /budgets ---------------------------------------------


def test_list_budgets_flattens(handler):
    repo = FakeBudgetRepo(budgets={
        "coffee": {"target": Decimal("58")},
        "groceries": {"target": Decimal("320")},
    })

    result = handler.list_budgets(repo)

    assert result == {"coffee": Decimal("58"), "groceries": Decimal("320")}


def test_list_budgets_empty(handler):
    repo = FakeBudgetRepo()

    assert handler.list_budgets(repo) == {}


# --- handler-level: dispatch -------------------------------------------------


def test_get_budgets_dispatch(handler, monkeypatch):
    repo = FakeBudgetRepo(budgets={"coffee": {"target": Decimal("58")}})
    monkeypatch.setattr(handler, "BudgetRepository", lambda: repo)

    resp = handler.lambda_handler(
        {"rawPath": "/budgets", "requestContext": {"http": {"method": "GET"}}}, None)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"coffee": 58}


def test_put_budget_dispatch(handler, monkeypatch):
    repo = FakeBudgetRepo()
    monkeypatch.setattr(handler, "BudgetRepository", lambda: repo)

    resp = handler.lambda_handler(_put_budget_event(), None)

    assert resp["statusCode"] == 200
    assert repo.set_calls == [("coffee", Decimal("58"))]


def test_unknown_budget_method_falls_through_404(handler, monkeypatch):
    # DELETE /budgets/{category} isn't a route -> catch-all 404.
    monkeypatch.setattr(handler, "BudgetRepository", lambda: FakeBudgetRepo())

    resp = handler.lambda_handler({
        "rawPath": "/budgets/coffee",
        "requestContext": {"http": {"method": "DELETE"}},
        "pathParameters": {"category": "coffee"},
    }, None)

    assert resp["statusCode"] == 404


def test_set_budget_conflict_returns_409(handler, monkeypatch):
    # A repo that exhausts its retry budget raises VersionConflictError; the shared
    # dispatch wrapper maps it to 409.
    repo = FakeBudgetRepo(conflict_exc=handler.VersionConflictError)
    monkeypatch.setattr(handler, "BudgetRepository", lambda: repo)

    resp = handler.lambda_handler(_put_budget_event(), None)

    assert resp["statusCode"] == 409


# --- repository-level: storage logic via an in-memory fake table -------------


def _ccfe():
    err = ClientError()
    err.response = {"Error": {"Code": "ConditionalCheckFailedException"}}
    return err


class FakeBudgetTable:
    """In-memory table emulating the calls BudgetRepository makes: get_item,
    conditional put_item, and the nested UPSERT update_item (no exists guard)."""

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
        values = ExpressionAttributeValues

        # attribute_exists(pk) AND #v = :expected — the optimistic-lock guard.
        if item is None or item["version"] != values[":expected"]:
            raise _ccfe()

        # Budget upsert: SET #items.#id = :val, set whether or not the id existed.
        cat_id = ExpressionAttributeNames["#id"]
        item["items"][cat_id] = copy.deepcopy(values[":val"])
        item["version"] = values[":next"]


def _repo_with_fake_table(handler):
    import repository
    repo = repository.BudgetRepository()
    repo._table = FakeBudgetTable()
    return repository, repo


def test_repo_list_budgets_seeds_empty_then_stable(handler):
    repository, repo = _repo_with_fake_table(handler)

    first = repo.list_budgets()
    second = repo.list_budgets()  # must not re-seed

    assert first == {} and second == {}
    config = repo._table.store[("BUDGETS", "BUDGETS")]
    assert config["items"] == {} and config["version"] == 1


def test_repo_set_budget_writes(handler):
    repository, repo = _repo_with_fake_table(handler)

    saved = repo.set_budget("coffee", Decimal("58"))

    config = repo._table.store[("BUDGETS", "BUDGETS")]
    assert config["items"]["coffee"] == {"target": Decimal("58")}
    assert config["version"] == 2
    assert saved == {"id": "coffee", "target": Decimal("58")}


def test_repo_set_budget_upsert_overwrites(handler):
    # The exact case a cloned category FakeTable would get wrong: set the same id
    # twice -> overwrite + version bump, never a duplicate/CCFE.
    repository, repo = _repo_with_fake_table(handler)

    repo.set_budget("coffee", Decimal("58"))
    repo.set_budget("coffee", Decimal("70"))

    config = repo._table.store[("BUDGETS", "BUDGETS")]
    assert config["items"]["coffee"] == {"target": Decimal("70")}
    assert config["version"] == 3


def test_repo_set_budget_preserves_other_keys(handler):
    repository, repo = _repo_with_fake_table(handler)

    repo.set_budget("coffee", Decimal("58"))
    repo.set_budget("groceries", Decimal("320"))

    items = repo._table.store[("BUDGETS", "BUDGETS")]["items"]
    assert items == {"coffee": {"target": Decimal("58")},
                     "groceries": {"target": Decimal("320")}}


def _bump_version(item):
    item["version"] = item["version"] + 1  # Decimal + int -> Decimal


def test_repo_set_budget_retries_after_version_race(handler):
    repository, repo = _repo_with_fake_table(handler)
    repo._table.before_update.append(_bump_version)

    repo.set_budget("coffee", Decimal("58"))

    config = repo._table.store[("BUDGETS", "BUDGETS")]
    assert config["items"]["coffee"] == {"target": Decimal("58")}
    assert config["version"] == 3  # seed(1) + concurrent bump(->2) + our write(->3)


def test_repo_set_budget_raises_under_sustained_contention(handler):
    # Every attempt sees a fresh version bump -> never converges -> 409.
    repository, repo = _repo_with_fake_table(handler)
    repo._table.before_update.extend([_bump_version, _bump_version])

    try:
        repo.set_budget("coffee", Decimal("58"))
        assert False, "expected VersionConflictError under sustained contention"
    except repository.VersionConflictError:
        pass


# --- rollup S1: pure summarise_transactions + current_cycle_window -----------


def _txn(category, amount, status="posted", counts=True):
    return {"category": category, "amount": Decimal(str(amount)), "status": status,
            "counts_to_budget": counts}


def test_summarise_routes_posted_and_pending(handler):
    # Spend is stored negative; posted -> posted bucket, pending -> pending bucket.
    txns = [_txn("coffee", -50, "posted"), _txn("coffee", -12, "pending")]

    result = handler.summarise_transactions(txns, {"coffee"})

    assert result == {"coffee": {"posted": Decimal("50"), "pending": Decimal("12")}}


def test_summarise_sums_multiple_and_ignores_others(handler):
    txns = [
        _txn("coffee", -50), _txn("coffee", -8),          # summed
        _txn("groceries", -30),                            # different category
        _txn("coffee", -99, counts=False),                 # not counts_to_budget
        _txn("income", -100),                              # income category
        _txn(None, -20),                                   # uncategorized
        _txn("unbudgeted", -40),                           # no target -> skipped
    ]

    result = handler.summarise_transactions(txns, {"coffee", "groceries"})

    assert result["coffee"] == {"posted": Decimal("58"), "pending": Decimal("0")}
    assert result["groceries"] == {"posted": Decimal("30"), "pending": Decimal("0")}
    assert "unbudgeted" not in result and "income" not in result


def test_summarise_refund_reduces_spent(handler):
    # A refund (positive amount) in a spend category reduces posted spend (net).
    txns = [_txn("coffee", -50), _txn("coffee", 20)]

    result = handler.summarise_transactions(txns, {"coffee"})

    assert result["coffee"]["posted"] == Decimal("30")


def test_summarise_net_refund_clamped_to_zero(handler):
    # A category whose net is a refund clamps at 0 (no negative bar).
    txns = [_txn("coffee", 20)]

    result = handler.summarise_transactions(txns, {"coffee"})

    assert result["coffee"]["posted"] == Decimal("0")


def test_summarise_empty(handler):
    assert handler.summarise_transactions([], {"coffee"}) == {}


def test_current_cycle_window_bounds(handler):
    from datetime import datetime, timezone, timedelta
    today = datetime.now(timezone.utc).date()

    start, end = handler.current_cycle_window(14)

    assert start == (today - timedelta(days=14)).isoformat()
    assert end == (today + timedelta(days=1)).isoformat()


def test_current_cycle_window_length_varies(handler):
    from datetime import datetime, timezone, timedelta
    today = datetime.now(timezone.utc).date()

    assert handler.current_cycle_window(7)[0] == (today - timedelta(days=7)).isoformat()
    assert handler.current_cycle_window(30)[0] == (today - timedelta(days=30)).isoformat()
