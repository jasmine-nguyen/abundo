import logging
from constants import ACCOUNT_ID_MAP
from decimal import Decimal

from models import Transaction

logger = logging.getLogger(__name__)


class UnknownAccountError(Exception):
    pass


def resolve_account_id(banksync_account_id: str) -> str:
    internal_id = ACCOUNT_ID_MAP.get(banksync_account_id)
    if internal_id is None:
        raise UnknownAccountError(
            f"Unknown BankSync accountId {banksync_account_id!r} — add it to ACCOUNT_ID_MAP"
        )
    return internal_id


class BankSyncClient:
    @staticmethod
    def normalise(row: dict) -> Transaction:
        """Maps BankSync's specific fields to whittle's standard format"""
        normalised: Transaction = {
            "transaction_id": str(row["id"]),
            "date": row["date"],
            "authorized_date": row.get("authorizedDate", ""),
            "description": row["description"],
            "merchant_name": row.get("merchantName", ""),
            "amount": Decimal(str(row["amount"])),
            "account_id": resolve_account_id(str(row["accountId"])),
            "account_name": row["accountName"],
            "category": row["category"],
            "status": "pending" if row["pending"] else "posted",
            "type": row["type"],
            "counts_to_budget": True,  # TODO: revisit when building excluding transaction
            # None when missing or JSON-null (the case today). sanitise_transaction
            # strips None, so it never bloats the stored item.
            "pending_transaction_id": row.get("pendingTransactionId"),
        }

        return normalised
