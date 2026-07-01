from constants import ACCOUNT_ID_MAP, TRANSACTION_PATH
from datetime import datetime, timedelta, timezone
from repository import TransactionRepository
from encoders import DecimalEncoder
import json


def lambda_handler(event, context):
    path = event.get("rawPath", "")
    method = event.get("requestContext", {}).get("http", {}).get("method", "")

    if path == TRANSACTION_PATH and method == "GET":
        repo = TransactionRepository()
        return {
            "statusCode": 200,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps(get_recent_transactions(repo), cls=DecimalEncoder),
        }

    return {"statusCode": 404, "body": json.dumps({"error": "Not found"})}


def get_recent_transactions(repo: TransactionRepository) -> list[dict]:
    # calculate date range
    today = datetime.now(timezone.utc).date()
    start_date = (today - timedelta(days=7)).isoformat()
    end_date = (
        today + timedelta(days=1)
    ).isoformat()  # +1 day covers AEST dates ahead of UTC

    all_recent_transactions = []
    # query each account
    for account_id in ACCOUNT_ID_MAP.values():
        recent_transactions, _ = repo.get_transactions_by_date_range(
            account_id, start_date, end_date=end_date
        )
        all_recent_transactions.extend(recent_transactions)

    # remove pk and sk before returning to api, and ensure sparse fields default to None
    for txn in all_recent_transactions:
        txn.pop("pk", None)
        txn.pop("sk", None)
        txn.setdefault("category", None)

    # sort all transactions by date, newest first
    sorted_all_recent_transactions = sorted(
        all_recent_transactions, key=lambda txn: txn["date"], reverse=True
    )

    return sorted_all_recent_transactions
