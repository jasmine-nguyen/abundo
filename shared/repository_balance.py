"""Home-loan balance storage: the latest live mortgage balance polled from
BankSync (getBalance), kept as a single DynamoDB item, overwritten in place on
every poll (WHIT-8).

Deliberately keyed under its OWN partition (pk="BALANCE#<account_id>") rather
than the transaction partition (pk="ACCOUNT#<account_id>"): the balance is a
standalone latest-value row, and keeping it out of ACCOUNT# means the
pending-transaction scans never sweep it up. It also carries NO `account_id`/
`date` attributes, so it never leaks into the `date-index` GSI that the windowed
transaction feed queries. One writer (the poller), so no version guard is needed.
"""

from decimal import Decimal
from typing import Any, Optional

import boto3
from botocore.exceptions import ClientError

from repository_base import REGION_NAME, TABLE_NAME, handle_database_error


def _balance_key(account_id: str) -> dict:
    return {"pk": f"BALANCE#{account_id}", "sk": "BALANCE"}


def _account_balance_key(account_id: str) -> dict:
    return {"pk": f"ACCTBAL#{account_id}", "sk": "BALANCE"}


# The on-demand refresh throttle marker: a single row holding the epoch of the last live
# BankSync fetch. Its sk is "MARKER" (not "BALANCE") and "REFRESH" is never an account id,
# so it can never be mistaken for a balance row by list_balances; it carries no
# `account_id`/`date`, so it stays out of the date-index GSI.
def _refresh_marker_key() -> dict:
    return {"pk": "ACCTBAL#REFRESH", "sk": "MARKER"}


class HomeLoanBalanceRepository:
    """Stores the latest home-loan balance as a single DynamoDB item.

    The item at pk="BALANCE#<account_id>", sk="BALANCE" holds the current
    `balance` (a positive Decimal — the outstanding principal), the `as_of`
    timestamp BankSync reported it, and the `currency`. `upsert_balance`
    overwrites the whole item each poll; `get_balance` returns it (or None before
    the first poll has landed).
    """

    def __init__(self) -> None:
        self._dynamodb = None
        self._table = None

    def _get_table(self) -> Any:
        if self._table is None:
            self._dynamodb = boto3.resource("dynamodb", region_name=REGION_NAME)
            self._table = self._dynamodb.Table(TABLE_NAME)
        return self._table

    def upsert_balance(
        self, account_id: str, balance: Decimal, as_of: str, currency: str
    ) -> None:
        """Overwrite the stored balance for `account_id`.

        A plain put_item (no condition) — the poller is the single writer and each
        run replaces the row wholesale with the freshest reading. Intentionally
        writes no `account_id`/`date` attributes so the item stays out of the
        date-index GSI.
        """
        try:
            self._get_table().put_item(
                Item={
                    **_balance_key(account_id),
                    "balance": balance,
                    "as_of": as_of,
                    "currency": currency,
                }
            )
        except ClientError as e:
            handle_database_error(e, "upsert home-loan balance")

    def get_balance(self, account_id: str) -> Optional[dict]:
        """Return {"balance": Decimal, "as_of": str, "currency": str} or None if
        no balance has been stored yet (before the first successful poll)."""
        try:
            item = self._get_table().get_item(Key=_balance_key(account_id)).get("Item")
        except ClientError as e:
            handle_database_error(e, "read home-loan balance")
        if item is None:
            return None
        return {
            "balance": item["balance"],
            "as_of": item["as_of"],
            "currency": item["currency"],
        }


class AccountBalanceRepository:
    """Latest live balance per linked account — one DynamoDB item each (WHIT-212).

    The Accounts tab shows a balance per account. Unlike HomeLoanBalanceRepository —
    which stores the mortgage's ABS outstanding principal for the Goal screen — this keeps
    the SIGNED balance BankSync reports (spending positive; a loan or credit-card balance
    negative) plus the account's available balance, currency, and type, so the app can
    render each card exactly as the bank sees it. Stored under its OWN partition
    (pk="ACCTBAL#<account_id>"), distinct from both BALANCE#<id> (the loan row) and
    ACCOUNT#<id> (transactions), and carries no `account_id`/`date` attribute so it never
    leaks into the date-index GSI. One writer (the poller), so no version guard is needed.
    """

    def __init__(self) -> None:
        self._dynamodb = None
        self._table = None

    def _get_table(self) -> Any:
        if self._table is None:
            self._dynamodb = boto3.resource("dynamodb", region_name=REGION_NAME)
            self._table = self._dynamodb.Table(TABLE_NAME)
        return self._table

    def upsert_balance(
        self,
        account_id: str,
        amount: Decimal,
        available_balance: Optional[Decimal],
        currency: str,
        as_of: str,
        account_type: Optional[str],
    ) -> None:
        """Overwrite the stored balance for `account_id` (plain put — single writer).

        `amount` is stored SIGNED (no abs). Writes no `account_id`/`date` attribute so the
        row stays out of the date-index GSI. `available_balance`/`account_type` are written
        only when present, so an account that reports neither stores a clean minimal item.
        """
        item = {
            **_account_balance_key(account_id),
            "amount": amount,
            "currency": currency,
            "as_of": as_of,
        }
        if available_balance is not None:
            item["available_balance"] = available_balance
        if account_type is not None:
            item["account_type"] = account_type
        try:
            self._get_table().put_item(Item=item)
        except ClientError as e:
            handle_database_error(e, "upsert account balance")

    def list_balances(self, account_ids: list) -> list:
        """Return the stored balance for each of `account_ids` that has one.

        A per-id get (not a table scan) over the app's known, fixed set of accounts
        (ACCOUNT_ID_MAP's values) — tiny and cheap, so it needs no GSI. An account with no
        row yet (before its first poll) is simply omitted; the app shows a placeholder for
        it. Each returned dict carries its own `account_id` so the read API can build the
        response list without re-deriving the key.
        """
        out = []
        for account_id in account_ids:
            try:
                item = self._get_table().get_item(Key=_account_balance_key(account_id)).get("Item")
            except ClientError as e:
                handle_database_error(e, "read account balance")
            if item is None:
                continue
            out.append({
                "account_id": account_id,
                "amount": item["amount"],
                "available_balance": item.get("available_balance"),
                "currency": item["currency"],
                "as_of": item["as_of"],
                "account_type": item.get("account_type"),
            })
        return out

    def get_last_refresh_at(self) -> Optional[int]:
        """Epoch seconds of the last on-demand live refresh, or None if never refreshed.

        Backs the 60s throttle on POST /accounts/balances/refresh.
        """
        try:
            item = self._get_table().get_item(Key=_refresh_marker_key()).get("Item")
        except ClientError as e:
            handle_database_error(e, "read balance refresh marker")
        if item is None:
            return None
        return int(item["last_fetch_at"])

    def set_last_refresh_at(self, now: int) -> None:
        """Record that a live refresh was attempted at epoch `now` (plain put)."""
        try:
            self._get_table().put_item(
                Item={**_refresh_marker_key(), "last_fetch_at": now}
            )
        except ClientError as e:
            handle_database_error(e, "write balance refresh marker")


def _feed_watch_key(account_id: str) -> dict:
    return {"pk": f"FEEDWATCH#{account_id}", "sk": "MARKER"}


class FeedWatchRepository:
    """The bank-feed stall watch — one row per watched account (WHIT-606).

    Remembers which transaction ids the balance poller last saw, when it first saw them, the
    balance at that moment, and whether the stall push has already gone out. Own partition
    (pk="FEEDWATCH#<account_id>") and no `account_id`/`date` attributes, so the row stays out of
    the date-index GSI the poller reads those ids from. One writer (the poller).
    """

    def __init__(self) -> None:
        self._dynamodb = None
        self._table = None

    def _get_table(self) -> Any:
        if self._table is None:
            self._dynamodb = boto3.resource("dynamodb", region_name=REGION_NAME)
            self._table = self._dynamodb.Table(TABLE_NAME)
        return self._table

    def get_watch(self, account_id: str) -> Optional[dict]:
        """Return {"seen_ids": set, "seen_at": int, "amount_at_seen": Decimal, "alerted": bool},
        or None before the account's first check."""
        try:
            item = self._get_table().get_item(Key=_feed_watch_key(account_id)).get("Item")
        except ClientError as e:
            handle_database_error(e, "read feed watch")
        if item is None:
            return None
        return {
            "seen_ids": set(item["seen_ids"]),
            "seen_at": int(item["seen_at"]),
            "amount_at_seen": item["amount_at_seen"],
            "alerted": item["alerted"],
        }

    def put_watch(
        self, account_id: str, seen_ids: set, seen_at: int, amount_at_seen: Decimal, alerted: bool
    ) -> None:
        """Overwrite the account's watch row (plain put — single writer). `seen_ids` is stored
        as a list: a DynamoDB string set can't be empty, and an account can have no rows."""
        try:
            self._get_table().put_item(
                Item={
                    **_feed_watch_key(account_id),
                    "seen_ids": sorted(seen_ids),
                    "seen_at": seen_at,
                    "amount_at_seen": amount_at_seen,
                    "alerted": alerted,
                }
            )
        except ClientError as e:
            handle_database_error(e, "write feed watch")
