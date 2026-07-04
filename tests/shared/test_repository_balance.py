"""Tests for HomeLoanBalanceRepository (shared/repository_balance.py).

Backed by the in-memory FakeTable (see conftest's `balance_repo` fixture). The
key guarantees under test: an upsert overwrites the single balance row in place,
get_balance round-trips it (or returns None before the first write), and the
stored item carries NO `account_id`/`date` attributes — so it can never leak into
the `date-index` GSI the transaction feed queries.
"""

from decimal import Decimal


def test_get_balance_returns_none_before_any_write(balance_repo):
    assert balance_repo.get_balance("up-homeloan") is None


def test_upsert_then_get_round_trips(balance_repo):
    balance_repo.upsert_balance(
        "up-homeloan", Decimal("596642.43"), "2026-07-04T00:24:37.614Z", "AUD"
    )
    assert balance_repo.get_balance("up-homeloan") == {
        "balance": Decimal("596642.43"),
        "as_of": "2026-07-04T00:24:37.614Z",
        "currency": "AUD",
    }


def test_upsert_overwrites_in_place(balance_repo):
    balance_repo.upsert_balance("up-homeloan", Decimal("600000"), "2026-07-01T00:00:00Z", "AUD")
    balance_repo.upsert_balance("up-homeloan", Decimal("596642.43"), "2026-07-04T00:00:00Z", "AUD")
    # A second reading replaces the first — one row, latest wins.
    assert balance_repo.get_balance("up-homeloan")["balance"] == Decimal("596642.43")
    assert len(balance_repo._table.store) == 1


def test_stored_item_has_no_gsi_attributes(balance_repo):
    # The date-index GSI keys on account_id (HASH) + date (RANGE). The balance row
    # must carry neither, or it would pollute the windowed transaction feed.
    balance_repo.upsert_balance("up-homeloan", Decimal("596642.43"), "2026-07-04T00:00:00Z", "AUD")
    (item,) = balance_repo._table.store.values()
    assert "account_id" not in item
    assert "date" not in item
    # Keyed under its own partition, isolated from the ACCOUNT# transaction rows.
    assert item["pk"] == "BALANCE#up-homeloan"
    assert item["sk"] == "BALANCE"
