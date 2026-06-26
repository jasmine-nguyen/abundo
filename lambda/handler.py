from rapidfuzz import fuzz
from pocketsmith_client import Transaction


def handler(event, context):
    return {"statusCode": 200, "body": "ok"}


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
