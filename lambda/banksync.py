import logging
from constants import ACCOUNT_ID_MAP, HOMELOAN_ACCOUNT_ID, NON_BUDGET_CATEGORIES
from decimal import Decimal

from merchant import clean_merchant
from models import Transaction

logger = logging.getLogger(__name__)


class UnknownAccountError(Exception):
    pass


def _date_only(raw: str, field: str = "date") -> str:
    """Return the ``YYYY-MM-DD`` prefix of a BankSync date, defending the invariant
    the budget window relies on.

    The budget window is a string range compare (``Key("date").between(start, end)``
    with ``end = today``), which is sound *only* while dates are bare ``YYYY-MM-DD``:
    a datetime like ``"2026-01-16T10:00:00Z"`` sorts *after* ``"2026-01-16"``, so
    today's own charge would silently drop out of the window. BankSync sends
    date-only today, but the field is an unconstrained string, so we normalise on
    write rather than trust it.

    Slice, don't reject: per WHIT-83/84 the webhook must never drop a transaction, so
    a malformed value is truncated and logged (surfacing a format change in
    CloudWatch) instead of raising.
    """
    text = str(raw)
    head = text[:10]
    if text != head:
        logger.warning("%s carried more than YYYY-MM-DD, truncating: %r", field, text)
    return head


def resolve_account_id(banksync_account_id: str) -> str:
    internal_id = ACCOUNT_ID_MAP.get(banksync_account_id)
    if internal_id is None:
        raise UnknownAccountError(
            f"Unknown BankSync accountId {banksync_account_id!r} — add it to ACCOUNT_ID_MAP"
        )
    return internal_id


def counts_to_budget(internal_account_id: str, category: str) -> bool:
    """Whether a transaction counts toward a SPENDING budget (WHIT-50).

    Excluded: anything on the home-loan account (interest, repayment credits) and any
    transfer/loan-payment category (own-account transfers, investments, card payments,
    and the repayment debit leaving Spending). Income and refunds are left counting —
    the earn-target feature handles those. `category` is BankSync's raw value.
    """
    return (
        internal_account_id != HOMELOAN_ACCOUNT_ID
        and category not in NON_BUDGET_CATEGORIES
    )


class BankSyncClient:
    @staticmethod
    def normalise(row: dict) -> Transaction:
        """Maps BankSync's specific fields to abundo's standard format"""
        internal_account_id = resolve_account_id(str(row["accountId"]))
        normalised: Transaction = {
            "transaction_id": str(row["id"]),
            # Date-only on write: the budget window (date range compare) and
            # reconciliation (exact authorized_date match) both assume YYYY-MM-DD.
            "date": _date_only(row["date"]),
            "authorized_date": _date_only(row.get("authorizedDate", ""), "authorizedDate"),
            "description": row["description"],
            # description stays RAW (rules + audit rely on it); merchant_name is the
            # cleaned display name derived from it / merchantName (see merchant.py).
            "merchant_name": clean_merchant(row["description"], row.get("merchantName", "")),
            "amount": Decimal(str(row["amount"])),
            "account_id": internal_account_id,
            "account_name": row["accountName"],
            "category": row["category"],
            "status": "pending" if row["pending"] else "posted",
            "type": row["type"],
            "counts_to_budget": counts_to_budget(internal_account_id, row["category"]),
            # None when missing or JSON-null (the case today). sanitise_transaction
            # strips None, so it never bloats the stored item.
            "pending_transaction_id": row.get("pendingTransactionId"),
        }

        return normalised
