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


# --- handler-level: GET /budgets (rollup, approach C) ------------------------


class FakeTransactionRepo:
    """Stand-in for TransactionRepository. Returns queued (items, cursor) pages
    across calls; account/date args are recorded but ignored. Defaults to a single
    page then empties, so the per-account loop sums each transaction once."""

    def __init__(self, transactions=None, pages=None):
        # pages: [(items, cursor), ...] to model a multi-page result; otherwise a
        # single page of `transactions` then empty.
        self._queue = list(pages) if pages is not None else [(list(transactions or []), None)]
        self.calls = []

    def get_transactions_by_date_range(self, account_id, start_date, end_date, limit=20, cursor=None):
        self.calls.append((account_id, start_date, end_date, limit, cursor))
        return self._queue.pop(0) if self._queue else ([], None)


class FakePayCycleRepo:
    """Stand-in for PayCycleRepository. Returns a fixed cycle and counts reads so a
    test can assert the empty-budget short-circuit skips the pay-cycle read."""

    def __init__(self, length=14, last_pay_date="2024-01-03"):
        self._cycle = {"length": length, "last_pay_date": last_pay_date}
        self.get_calls = 0

    def get_paycycle(self):
        self.get_calls += 1
        return dict(self._cycle)


def test_list_budgets_rollup_shape(handler):
    budget_repo = FakeBudgetRepo(budgets={
        "coffee": {"target": Decimal("58")},
        "groceries": {"target": Decimal("320")},
    })
    txn_repo = FakeTransactionRepo(transactions=[
        _transaction("coffee", -50, "posted"),
        _transaction("coffee", -12, "pending"),
        _transaction("groceries", -30, "posted"),
        _transaction("income", -100, "posted"),              # excluded (income)
        _transaction("coffee", -9, "posted", counts=False),  # excluded (!counts_to_budget)
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo())

    assert result == {
        "coffee": {"target": Decimal("58"), "posted": Decimal("50"), "pending": Decimal("12")},
        "groceries": {"target": Decimal("320"), "posted": Decimal("30"), "pending": Decimal("0")},
    }


def test_list_budgets_no_spend_is_zero(handler):
    budget_repo = FakeBudgetRepo(budgets={"coffee": {"target": Decimal("58")}})

    result = handler.list_budgets(budget_repo, FakeTransactionRepo(transactions=[]), FakePayCycleRepo())

    assert result == {"coffee": {"target": Decimal("58"), "posted": Decimal("0"), "pending": Decimal("0")}}


def test_list_budgets_empty_skips_txn_scan(handler):
    budget_repo = FakeBudgetRepo()  # no targets
    txn_repo = FakeTransactionRepo(transactions=[_transaction("coffee", -50)])
    paycycle_repo = FakePayCycleRepo()

    result = handler.list_budgets(budget_repo, txn_repo, paycycle_repo)

    assert result == {}
    assert txn_repo.calls == []          # no budgets -> don't scan transactions
    assert paycycle_repo.get_calls == 0  # ...and don't even read the pay cycle


def test_list_budgets_paginates(handler):
    # A >1-page window must sum across ALL pages, not stop at the first.
    budget_repo = FakeBudgetRepo(budgets={"coffee": {"target": Decimal("100")}})
    txn_repo = FakeTransactionRepo(pages=[
        ([_transaction("coffee", -40, "posted")], {"cursor": 1}),  # page 1, more to come
        ([_transaction("coffee", -25, "posted")], None),           # page 2, done
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo())

    assert result["coffee"]["posted"] == Decimal("65")  # 40 + 25 summed across pages


# --- handler-level: dispatch -------------------------------------------------


def test_get_budgets_dispatch(handler, monkeypatch):
    budget_repo = FakeBudgetRepo(budgets={"coffee": {"target": Decimal("58")}})
    txn_repo = FakeTransactionRepo(transactions=[_transaction("coffee", -50, "posted")])
    monkeypatch.setattr(handler, "BudgetRepository", lambda: budget_repo)
    monkeypatch.setattr(handler, "TransactionRepository", lambda: txn_repo)
    monkeypatch.setattr(handler, "PayCycleRepository", lambda: FakePayCycleRepo())

    resp = handler.lambda_handler(
        {"rawPath": "/budgets", "requestContext": {"http": {"method": "GET"}}}, None)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"coffee": {"target": 58, "posted": 50, "pending": 0}}


def test_get_budgets_dispatch_ignores_days_param(handler, monkeypatch):
    # Back-compat: a deployed client still sends ?days=. The server no longer reads
    # it (the window is last_pay_date-derived), so the request still 200s and the window
    # start is the stored cycle's cycle_start, NOT today-days.
    monkeypatch.setattr(handler, "BudgetRepository",
                        lambda: FakeBudgetRepo(budgets={"coffee": {"target": Decimal("58")}}))
    txn_repo = FakeTransactionRepo(transactions=[])
    monkeypatch.setattr(handler, "TransactionRepository", lambda: txn_repo)
    monkeypatch.setattr(handler, "PayCycleRepository",
                        lambda: FakePayCycleRepo(length=14, last_pay_date="2024-01-03"))

    resp = handler.lambda_handler({
        "rawPath": "/budgets",
        "requestContext": {"http": {"method": "GET"}},
        "queryStringParameters": {"days": "7"},
    }, None)

    assert resp["statusCode"] == 200  # ?days is ignored, not a 400
    expected_start, _ = handler.current_cycle_window("2024-01-03", 14)
    assert txn_repo.calls[0][1] == expected_start  # last_pay_date-derived, not today-7


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


def _transaction(category, amount, status="posted", counts=True):
    return {"category": category, "amount": Decimal(str(amount)), "status": status,
            "counts_to_budget": counts}


def test_summarise_routes_posted_and_pending(handler):
    # Spend is stored negative; posted -> posted bucket, pending -> pending bucket.
    txns = [_transaction("coffee", -50, "posted"), _transaction("coffee", -12, "pending")]

    result = handler.summarise_transactions(txns, {"coffee"})

    assert result == {"coffee": {"posted": Decimal("50"), "pending": Decimal("12")}}


def test_summarise_sums_multiple_and_ignores_others(handler):
    txns = [
        _transaction("coffee", -50), _transaction("coffee", -8),          # summed
        _transaction("groceries", -30),                            # different category
        _transaction("coffee", -99, counts=False),                 # not counts_to_budget
        _transaction("income", -100),                              # income category
        _transaction(None, -20),                                   # uncategorized
        _transaction("unbudgeted", -40),                           # no target -> skipped
    ]

    result = handler.summarise_transactions(txns, {"coffee", "groceries"})

    assert result["coffee"] == {"posted": Decimal("58"), "pending": Decimal("0")}
    assert result["groceries"] == {"posted": Decimal("30"), "pending": Decimal("0")}
    assert "unbudgeted" not in result and "income" not in result


def test_summarise_refund_reduces_spent(handler):
    # A refund (positive amount) in a spend category reduces posted spend (net).
    txns = [_transaction("coffee", -50), _transaction("coffee", 20)]

    result = handler.summarise_transactions(txns, {"coffee"})

    assert result["coffee"]["posted"] == Decimal("30")


def test_summarise_net_refund_clamped_to_zero(handler):
    # A category whose net is a refund clamps at 0 (no negative bar).
    txns = [_transaction("coffee", 20)]

    result = handler.summarise_transactions(txns, {"coffee"})

    assert result["coffee"]["posted"] == Decimal("0")


def test_summarise_empty(handler):
    assert handler.summarise_transactions([], {"coffee"}) == {}


def test_summarise_skips_unknown_status(handler):
    # An unrecognised status isn't guessed into a bucket -> the txn is skipped.
    txns = [_transaction("coffee", -50, status="settled")]

    assert handler.summarise_transactions(txns, {"coffee"}) == {}


def test_current_cycle_window_end_is_today_inclusive(handler):
    from datetime import date
    # WHIT-75: the end bound is today itself (inclusive), NOT today+1 — date-only
    # storage + inclusive `between` means `today` already covers all of today's spend,
    # and a transaction dated tomorrow must be excluded.
    _, end = handler.current_cycle_window("2024-01-03", 14, today=date(2024, 2, 15))
    assert end == "2024-02-15"          # today, inclusive
    assert end < "2024-02-16"           # tomorrow is out of the window


def test_current_cycle_window_k_selection_across_cycles(handler):
    from datetime import date
    # last_pay_date 2024-01-03, length 14; today 2024-02-15 is 43 days on -> k=3 -> +42 days.
    start, _ = handler.current_cycle_window("2024-01-03", 14, today=date(2024, 2, 15))
    assert start == "2024-02-14"


def test_current_cycle_window_today_on_payday_starts_new_cycle(handler):
    from datetime import date
    # Exactly `length` days after the last_pay_date: a fresh cycle starts today.
    start, _ = handler.current_cycle_window("2024-01-03", 14, today=date(2024, 1, 17))
    assert start == "2024-01-17"


def test_current_cycle_window_day_before_payday_still_previous_cycle(handler):
    from datetime import date
    # length-1 days after the last_pay_date: still the last_pay_date's cycle.
    start, _ = handler.current_cycle_window("2024-01-03", 14, today=date(2024, 1, 16))
    assert start == "2024-01-03"


def test_current_cycle_window_length_variants(handler):
    from datetime import date
    today = date(2024, 3, 1)  # 58 days after the last_pay_date
    # weekly: k=8 -> +56 days -> 2024-02-28; monthly: k=1 -> +30 -> 2024-02-02.
    assert handler.current_cycle_window("2024-01-03", 7, today=today)[0] == "2024-02-28"
    assert handler.current_cycle_window("2024-01-03", 30, today=today)[0] == "2024-02-02"


def test_current_cycle_window_future_last_pay_date_clamped(handler):
    from datetime import date
    # A future last_pay_date has no valid k; the window must not invert. It collapses
    # to the single inclusive day [today, today] — today's spend still counts.
    start, end = handler.current_cycle_window("2024-06-05", 14, today=date(2024, 6, 1))
    assert start == "2024-06-01"       # clamped to today
    assert start == end == "2024-06-01"  # single inclusive day, not inverted/empty


def test_current_cycle_window_payday_end_covers_today(handler):
    from datetime import date
    # On payday, cycle_start == today; the window is the single inclusive day
    # [today, today], so a transaction dated today still lands in the fresh cycle.
    start, end = handler.current_cycle_window("2024-01-03", 14, today=date(2024, 1, 17))
    assert start == end == "2024-01-17"


class _DateFilteringTransactionRepo:
    """Like FakeTransactionRepo, but HONOURS the date bounds the way DynamoDB
    `between` does — inclusive on BOTH ends over date-only YYYY-MM-DD strings — so a
    boundary test can prove exactly which dates the window pulls in. Serves the pool
    once (then empties) so the per-account loop sums each transaction a single time."""

    def __init__(self, transactions):
        self._txns = list(transactions)
        self._served = False
        self.calls = []

    def get_transactions_by_date_range(self, account_id, start_date, end_date, limit=20, cursor=None):
        self.calls.append((account_id, start_date, end_date, limit, cursor))
        if self._served:
            return [], None
        self._served = True
        page = [t for t in self._txns if start_date <= t["date"] <= end_date]
        return page, None


def test_list_budgets_window_excludes_tomorrow_includes_boundaries(handler, monkeypatch):
    # WHIT-75 end-to-end: on the day BEFORE payday, a transaction dated TOMORROW (the
    # next payday) must NOT smear into this cycle, while both cycle_start and today
    # count. Fails on the old `today+1` end (would sum 30); passes on the fix (sums 20).
    from datetime import date
    monkeypatch.setattr(handler, "_melbourne_today", lambda: date(2024, 1, 16))
    budget_repo = FakeBudgetRepo(budgets={"coffee": {"target": Decimal("100")}})
    txn_repo = _DateFilteringTransactionRepo(transactions=[
        {**_transaction("coffee", -10, "posted"), "date": "2024-01-03"},  # cycle_start -> IN
        {**_transaction("coffee", -10, "posted"), "date": "2024-01-16"},  # today       -> IN
        {**_transaction("coffee", -10, "posted"), "date": "2024-01-17"},  # tomorrow    -> OUT
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo())

    assert result == {"coffee": {"target": Decimal("100"), "posted": Decimal("20"), "pending": Decimal("0")}}
    assert txn_repo.calls[0][2] == "2024-01-16"  # queried end bound is today, not today+1


def test_list_budgets_window_excludes_day_before_cycle_start(handler, monkeypatch):
    # WHIT-75 lower-bound guard (regression): a transaction dated the day BEFORE
    # cycle_start (last cycle's spend) must NOT count in this cycle, while cycle_start
    # itself does. Locks the start bound the same way the end bound is locked.
    from datetime import date
    monkeypatch.setattr(handler, "_melbourne_today", lambda: date(2024, 1, 16))
    budget_repo = FakeBudgetRepo(budgets={"coffee": {"target": Decimal("100")}})
    txn_repo = _DateFilteringTransactionRepo(transactions=[
        {**_transaction("coffee", -10, "posted"), "date": "2024-01-02"},  # day before cycle_start -> OUT
        {**_transaction("coffee", -10, "posted"), "date": "2024-01-03"},  # cycle_start            -> IN
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo())

    assert result == {"coffee": {"target": Decimal("100"), "posted": Decimal("10"), "pending": Decimal("0")}}
    assert txn_repo.calls[0][1] == "2024-01-03"  # queried start bound is cycle_start


def test_list_budgets_window_excludes_pending_dated_tomorrow(handler, monkeypatch):
    # WHIT-75 for the PENDING bucket: a pending authorisation dated tomorrow must not
    # leak in either — pending stays 0, today's pending still counts.
    from datetime import date
    monkeypatch.setattr(handler, "_melbourne_today", lambda: date(2024, 1, 16))
    budget_repo = FakeBudgetRepo(budgets={"coffee": {"target": Decimal("100")}})
    txn_repo = _DateFilteringTransactionRepo(transactions=[
        {**_transaction("coffee", -10, "pending"), "date": "2024-01-16"},  # today    -> IN
        {**_transaction("coffee", -10, "pending"), "date": "2024-01-17"},  # tomorrow -> OUT
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo())

    assert result == {"coffee": {"target": Decimal("100"), "posted": Decimal("0"), "pending": Decimal("10")}}


def test_list_budgets_window_monthly_excludes_tomorrow(handler, monkeypatch):
    # Boundary independence from cycle length: with a 30-day cycle the end is still
    # `today`, so a txn dated tomorrow is excluded and cycle_start still counts.
    from datetime import date
    monkeypatch.setattr(handler, "_melbourne_today", lambda: date(2024, 2, 1))  # 29 days on -> cycle_start 2024-01-03
    budget_repo = FakeBudgetRepo(budgets={"coffee": {"target": Decimal("100")}})
    txn_repo = _DateFilteringTransactionRepo(transactions=[
        {**_transaction("coffee", -10, "posted"), "date": "2024-01-03"},  # cycle_start -> IN
        {**_transaction("coffee", -10, "posted"), "date": "2024-02-01"},  # today       -> IN
        {**_transaction("coffee", -10, "posted"), "date": "2024-02-02"},  # tomorrow    -> OUT
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(length=30))

    assert result == {"coffee": {"target": Decimal("100"), "posted": Decimal("20"), "pending": Decimal("0")}}
    assert txn_repo.calls[0][2] == "2024-02-01"  # end bound is today regardless of length


def test_current_cycle_window_injectable_today_is_deterministic(handler):
    from datetime import date
    a = handler.current_cycle_window("2024-01-03", 14, today=date(2024, 2, 15))
    b = handler.current_cycle_window("2024-01-03", 14, today=date(2024, 2, 15))
    assert a == b


def test_current_cycle_window_defaults_to_melbourne_today(handler, monkeypatch):
    from datetime import date
    # With no explicit `today`, the window uses _melbourne_today().
    monkeypatch.setattr(handler, "_melbourne_today", lambda: date(2024, 2, 15))
    start, end = handler.current_cycle_window("2024-01-03", 14)
    assert (start, end) == ("2024-02-14", "2024-02-15")


def test_melbourne_today_maps_utc_instant_to_local_date(handler, monkeypatch):
    from datetime import datetime, timezone
    # 2024-06-30T15:30Z is already 2024-07-01 in Melbourne (UTC+10 in June/AEST).
    class _FrozenDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2024, 6, 30, 15, 30, tzinfo=timezone.utc).astimezone(tz)
    monkeypatch.setattr(handler, "datetime", _FrozenDatetime)
    assert handler._melbourne_today().isoformat() == "2024-07-01"


def test_melbourne_today_falls_back_to_utc_when_tzdata_missing(handler, monkeypatch):
    from datetime import datetime, timezone
    from zoneinfo import ZoneInfoNotFoundError
    # Simulate tzdata missing from the layer: ZoneInfo raises. The budget path must
    # degrade to UTC, not 500.
    monkeypatch.setattr(handler, "_MELBOURNE", None)
    def _boom(name):
        raise ZoneInfoNotFoundError(name)
    monkeypatch.setattr(handler, "ZoneInfo", _boom)
    assert handler._melbourne_today() == datetime.now(timezone.utc).date()
