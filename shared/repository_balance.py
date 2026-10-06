"""Balance storage: the latest live balance per account polled from BankSync
(getBalance, pk="ACCTBAL#<account_id>"), the on-demand refresh throttle marker, and the
bank-feed stall watch rows (pk="FEEDWATCH#<account_id>").

Each lives under its OWN partition rather than the transaction partition
(pk="ACCOUNT#<account_id>"), so the pending-transaction scans never sweep them up, and
carries NO `account_id`/`date` attributes, so it never leaks into the `date-index` GSI
that the windowed transaction feed queries.
"""

from decimal import Decimal
from typing import Optional

from repository_base import RepositoryBase, db_errors


def _account_balance_key(account_id: str) -> dict:
    return {"pk": f"ACCTBAL#{account_id}", "sk": "BALANCE"}


# The on-demand refresh throttle marker: a single row holding the epoch of the last live
# BankSync fetch. Its sk is "MARKER" (not "BALANCE") and "REFRESH" is never an account id,
# so it can never be mistaken for a balance row by list_balances; it carries no
# `account_id`/`date`, so it stays out of the date-index GSI.
def _refresh_marker_key() -> dict:
    return {"pk": "ACCTBAL#REFRESH", "sk": "MARKER"}


class AccountBalanceRepository(RepositoryBase):
    """Latest live balance per linked account — one DynamoDB item each (WHIT-212).

    The Accounts tab shows a balance per account. This keeps the SIGNED balance BankSync
    reports (spending positive; a loan or credit-card balance negative) plus the account's
    available balance, currency, and type, so the app can render each card exactly as the
    bank sees it. The Goal screen's `/homeloan` serves abs(amount) of the home loan's row.
    Stored under its OWN partition (pk="ACCTBAL#<account_id>"), distinct from ACCOUNT#<id>
    (transactions), and carries no `account_id`/`date` attribute so it never leaks into the
    date-index GSI. Plain puts (the poller and the on-demand refresh), no version guard.
    """

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
        with db_errors("upsert account balance"):
            self._get_table().put_item(Item=item)

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
            with db_errors("read account balance"):
                item = self._get_table().get_item(Key=_account_balance_key(account_id)).get("Item")
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
        with db_errors("read balance refresh marker"):
            item = self._get_table().get_item(Key=_refresh_marker_key()).get("Item")
        if item is None:
            return None
        return int(item["last_fetch_at"])

    def set_last_refresh_at(self, now: int) -> None:
        """Record that a live refresh was attempted at epoch `now` (plain put)."""
        with db_errors("write balance refresh marker"):
            self._get_table().put_item(
                Item={**_refresh_marker_key(), "last_fetch_at": now}
            )


def _feed_watch_key(account_id: str) -> dict:
    return {"pk": f"FEEDWATCH#{account_id}", "sk": "MARKER"}


class FeedWatchRepository(RepositoryBase):
    """The bank-feed stall watch — one row per watched account (WHIT-606).

    Remembers every transaction id the balance poller has seen in the look-back window (id ->
    bank date, so old ids can be dropped), when it last saw a new one, the balance at that
    moment, and whether the stall push has already gone out. Own partition
    (pk="FEEDWATCH#<account_id>") and no `account_id`/`date` attributes, so the row stays out of
    the date-index GSI the poller reads those ids from. One writer (the poller).
    """

    def get_watch(self, account_id: str) -> Optional[dict]:
        """Return {"seen_dates": {id: date}, "seen_at": int, "amount_at_seen": Decimal,
        "alerted": bool}, or None before the account's first check."""
        with db_errors("read feed watch"):
            item = self._get_table().get_item(Key=_feed_watch_key(account_id)).get("Item")
        if item is None:
            return None
        return {
            "seen_dates": dict(item["seen_dates"]),
            "seen_at": int(item["seen_at"]),
            "amount_at_seen": item["amount_at_seen"],
            "alerted": item["alerted"],
        }

    def put_watch(
        self, account_id: str, seen_dates: dict, seen_at: int, amount_at_seen: Decimal, alerted: bool
    ) -> None:
        """Overwrite the account's watch row (plain put — single writer)."""
        with db_errors("write feed watch"):
            self._get_table().put_item(
                Item={
                    **_feed_watch_key(account_id),
                    "seen_dates": seen_dates,
                    "seen_at": seen_at,
                    "amount_at_seen": amount_at_seen,
                    "alerted": alerted,
                }
            )
