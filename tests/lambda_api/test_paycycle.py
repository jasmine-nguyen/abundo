"""Tests for the pay-cycle endpoints (GET /paycycle, PUT /paycycle) and
PayCycleRepository.

Every test runs the REAL PayCycleRepository over the shared FakeTable (WHIT-625):
handler-level tests inject it directly, repository tests drive it on its own. Unlike
BudgetRepository the pay cycle is one settings object, not a per-key `items` map,
so the write REPLACES both `length` and `last_pay_date` together under the version guard.

The `handler` fixture (conftest.py) makes lambda_api importable in isolation and
puts `shared/` on the path, so `import repository_paycycle` inside a test resolves to
shared/repository_paycycle.py with boto3/botocore already faked.
"""

import json
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest

from _api_event import api_event
from _paycycle_fakes import paycycle_repo, stored_cycle


def _today_utc():
    return datetime.now(timezone.utc).date()


def _put_paycycle_event(body='{"length": 7, "last_pay_date": "2024-06-05"}', is_b64=False):
    return api_event("PUT", "/paycycle", raw=body, is_base64=is_b64)


# --- handler-level: PUT /paycycle --------------------------------------------


def test_set_paycycle_success(handler):
    table, repo = paycycle_repo()

    resp = handler.set_paycycle(_put_paycycle_event(), repo)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"length": 7, "last_pay_date": "2024-06-05"}
    assert stored_cycle(table) == (7, "2024-06-05")


def test_set_paycycle_last_pay_date_at_future_ceiling_accepted(handler):
    # The ceiling is today + 1 day (AEST-runs-ahead-of-UTC slack); exactly that is OK.
    _, repo = paycycle_repo()
    body = json.dumps({"length": 30, "last_pay_date": (_today_utc() + timedelta(days=1)).isoformat()})

    resp = handler.set_paycycle(_put_paycycle_event(body=body), repo)

    assert resp["statusCode"] == 200


def test_set_paycycle_future_last_pay_date_400(handler):
    table, repo = paycycle_repo()
    body = json.dumps({"length": 14, "last_pay_date": (_today_utc() + timedelta(days=5)).isoformat()})

    resp = handler.set_paycycle(_put_paycycle_event(body=body), repo)

    assert resp["statusCode"] == 400
    assert table.update_calls == []  # validation stops it before any write


@pytest.mark.parametrize("cycle", [
    {"length": 10, "last_pay_date": "2024-06-05"},
    {"length": True, "last_pay_date": "2024-06-05"},     # bool is an int subclass
    {"length": 14, "last_pay_date": "05/06/2024"},       # malformed date
])
def test_set_paycycle_bad_length_400(handler, cycle):
    table, repo = paycycle_repo()
    body = json.dumps(cycle)

    resp = handler.set_paycycle(_put_paycycle_event(body=body), repo)

    assert resp["statusCode"] == 400
    assert table.update_calls == []  # validation stops it before any write


# --- dispatch through lambda_handler -----------------------------------------


def test_get_paycycle_dispatch(handler, monkeypatch):
    from datetime import date
    import spend
    monkeypatch.setattr(spend, "melbourne_today", lambda: date(2024, 1, 10))
    _, repo = paycycle_repo({"length": 14, "last_pay_date": "2024-01-03"})
    monkeypatch.setattr(handler, "PayCycleRepository", lambda: repo)

    resp = handler.lambda_handler(api_event("GET", "/paycycle"), None)

    assert resp["statusCode"] == 200
    # days_left = next payday (03 + 14 = 17) - today (10) = 7.
    assert json.loads(resp["body"]) == {"length": 14, "last_pay_date": "2024-01-03", "days_left": 7}


def test_get_paycycle_view_days_left(handler, monkeypatch):
    from datetime import date
    import spend

    def _view(length, last_pay_date, today):
        monkeypatch.setattr(spend, "melbourne_today", lambda: today)
        return handler.get_paycycle_view(paycycle_repo({"length": length, "last_pay_date": last_pay_date})[1])

    # On payday -> a full cycle remains.
    assert _view(14, "2024-01-03", date(2024, 1, 17))["days_left"] == 14
    # Mid-cycle -> counts down to the next payday.
    assert _view(14, "2024-01-03", date(2024, 1, 16))["days_left"] == 1
    # The day after payday.
    assert _view(30, "2024-06-01", date(2024, 6, 2))["days_left"] == 29
    # A future last_pay_date clamps to today (no negative days_left).
    assert _view(14, "2024-06-01", date(2024, 1, 10))["days_left"] == 14


def test_put_paycycle_dispatch(handler, monkeypatch):
    table, repo = paycycle_repo()
    monkeypatch.setattr(handler, "PayCycleRepository", lambda: repo)

    resp = handler.lambda_handler(_put_paycycle_event(), None)

    assert resp["statusCode"] == 200
    assert stored_cycle(table) == (7, "2024-06-05")


def test_set_paycycle_conflict_returns_409(handler, monkeypatch):
    # A repo that exhausts its retry budget raises VersionConflictError; the shared
    # dispatch wrapper maps it to 409.
    table, repo = paycycle_repo()
    table.always_race()
    monkeypatch.setattr(handler, "PayCycleRepository", lambda: repo)

    resp = handler.lambda_handler(_put_paycycle_event(), None)

    assert resp["statusCode"] == 409


# --- repository-level: storage logic via an in-memory fake table -------------


def _repo_with_fake_table(handler):
    import repository_paycycle
    _, repo = paycycle_repo()
    return repository_paycycle, repo


def test_repo_get_paycycle_seeds_default_then_stable(handler):
    repository, repo = _repo_with_fake_table(handler)

    first = repo.get_paycycle()
    second = repo.get_paycycle()  # must not re-seed

    assert first == {"length": 14, "last_pay_date": "2024-01-03"}
    # DynamoDB stores numbers as Decimal; the API must serialise length as an int.
    assert isinstance(first["length"], int)
    assert second == first
    config = repo._table.store[("PAYCYCLE", "PAYCYCLE")]
    assert config["version"] == 1


def test_repo_set_paycycle_replaces_both_fields(handler):
    repository, repo = _repo_with_fake_table(handler)

    repo.set_paycycle(7, "2024-06-05")
    repo.set_paycycle(30, "2024-06-30")

    config = repo._table.store[("PAYCYCLE", "PAYCYCLE")]
    assert config["length"] == Decimal(30)
    assert config["last_pay_date"] == "2024-06-30"
    assert config["version"] == 3


def test_repo_set_paycycle_retries_after_version_race(handler):
    repository, repo = _repo_with_fake_table(handler)
    repo._table.race_next_update()

    repo.set_paycycle(7, "2024-06-05")

    config = repo._table.store[("PAYCYCLE", "PAYCYCLE")]
    assert config["length"] == Decimal(7)
    assert config["version"] == 3  # seed(1) + concurrent bump(->2) + our write(->3)
