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


# --- AccountBalanceRepository (WHIT-212) -------------------------------------


def test_account_balance_round_trips_signed_amount_and_extras(account_balance_repo):
    # The mortgage balance is stored SIGNED here (negative), unlike the abs home-loan row.
    account_balance_repo.upsert_balance(
        "up-homeloan", Decimal("-596642.43"), Decimal("0"), "AUD",
        "2026-07-08T09:29:49.358Z", "mortgage",
    )
    assert account_balance_repo.list_balances(["up-homeloan"]) == [{
        "account_id": "up-homeloan",
        "amount": Decimal("-596642.43"),
        "available_balance": Decimal("0"),
        "currency": "AUD",
        "as_of": "2026-07-08T09:29:49.358Z",
        "account_type": "mortgage",
    }]


def test_account_balance_stores_nothing_optional_when_absent(account_balance_repo):
    # No available_balance / account_type reported -> a clean minimal item, and the row
    # reads back with those fields as None.
    account_balance_repo.upsert_balance(
        "up-spending", Decimal("96270.59"), None, "AUD", "2026-07-08T09:32:02.405Z", None,
    )
    (item,) = account_balance_repo._table.store.values()
    assert "available_balance" not in item
    assert "account_type" not in item
    row = account_balance_repo.list_balances(["up-spending"])[0]
    assert row["available_balance"] is None
    assert row["account_type"] is None


def test_account_balance_upsert_overwrites_in_place(account_balance_repo):
    account_balance_repo.upsert_balance("anz", Decimal("-100"), None, "AUD", "d1", "unknown")
    account_balance_repo.upsert_balance("anz", Decimal("-6492.26"), Decimal("8171.88"), "AUD", "d2", "unknown")
    (row,) = account_balance_repo.list_balances(["anz"])
    assert row["amount"] == Decimal("-6492.26")
    assert len(account_balance_repo._table.store) == 1


def test_account_balance_list_omits_unpolled_accounts(account_balance_repo):
    account_balance_repo.upsert_balance("up-spending", Decimal("96270.59"), None, "AUD", "d", "checking")
    # Two ids requested, only one has a row -> the other is silently omitted (not an error,
    # not a null row) so the app shows a placeholder for it.
    out = account_balance_repo.list_balances(["up-spending", "anz-rewards-black-visa"])
    assert [r["account_id"] for r in out] == ["up-spending"]


def test_account_balance_list_is_empty_before_any_poll(account_balance_repo):
    assert account_balance_repo.list_balances(["up-spending", "up-homeloan"]) == []


def test_account_balance_keyed_under_own_partition_no_gsi_attrs(account_balance_repo):
    account_balance_repo.upsert_balance("up-homeloan", Decimal("-596642.43"), None, "AUD", "d", "mortgage")
    (item,) = account_balance_repo._table.store.values()
    # Distinct from BALANCE#<id> (the abs loan row) and ACCOUNT#<id> (transactions), and
    # carries neither GSI attribute so it can't pollute the windowed transaction feed.
    assert item["pk"] == "ACCTBAL#up-homeloan"
    assert item["sk"] == "BALANCE"
    assert "account_id" not in item
    assert "date" not in item
