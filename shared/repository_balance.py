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
