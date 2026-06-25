from decimal import Decimal
from typing import Optional, TypedDict
from rapidfuzz import fuzz


class Transaction(TypedDict):
    transaction_id: str
    account_id: str
    account_name: str
    date: str  # Use date if parsed into a datetime object
    amount: Decimal  # Best practice for financial transactions
    closing_balance: Decimal
    payee: str
    original_payee: str
    status: str
    type: str
    memo: Optional[str]
    source: str
    ps_category: Optional[str]
    category: Optional[str]  # Expresses that 'None' or 'str' is allowed
    notes: Optional[str]  # Expresses that 'None' or 'str' is allowed


def handler(event, context):
    return {"statusCode": 200, "body": "ok"}


def normalise(txn: dict) -> Transaction:
    txn_account: dict = txn["transaction_account"]

    normalised_transaction: Transaction = {
        "transaction_id": str(txn["id"]),
        "account_id": txn_account["account_id"],
        "account_name": txn_account["name"],
        "date": txn["date"],
        "amount": Decimal(str(txn["amount"])),
        "closing_balance": Decimal(str(txn["closing_balance"])),
        "payee": txn["payee"],
        "original_payee": txn["original_payee"],
        "status": txn["status"],
        "type": txn["type"],
        "memo": txn.get("memo", None),
        "source": txn["transaction_account"]["institution"]["title"],
        "ps_category": cat["title"] if (cat := txn.get("category")) else None,
        "category": None,
        "notes": None,
    }

    return normalised_transaction


def is_same_transaction(old_txn: Transaction, new_txn: Transaction) -> bool:
    account_id_match = new_txn["account_id"] == old_txn["account_id"]
    amount_match = new_txn["amount"] == old_txn["amount"]
    closing_balance_match = new_txn["closing_balance"] == old_txn["closing_balance"]
    payee_matching_score = fuzz.partial_ratio(new_txn["payee"], old_txn["payee"])

    return (
        account_id_match
        and amount_match
        and closing_balance_match
        and payee_matching_score > 80.0
    )
