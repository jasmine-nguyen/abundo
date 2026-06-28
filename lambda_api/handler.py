from datetime import datetime, timedelta, timezone
from repository import TransactionRepository
from encoders import DecimalEncoder
import json

# account ids for ANZ, Up Spending, Up Homeloan, hardcoded as they are rarely changed
ACCOUNT_IDS = ["5256839", "5256787", "5256791"]

TRANSACTION_PATH = "/transactions"


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
    today = datetime.now(timezone.utc).date().isoformat()
    start_date = (datetime.now(timezone.utc).date() - timedelta(days=5)).isoformat()

    all_recent_transactions = []
    # query each account
    for account_id in ACCOUNT_IDS:
        recent_transactions = repo.get_recent_transactions(
            account_id, start_date, end_date=today
        )
        print(f"recent_txn_for_account {account_id}: {recent_transactions}")
        if len(recent_transactions) > 0:
            all_recent_transactions.extend(recent_transactions)

    # sort all transactions by date, newest first
    sorted_all_recent_transactions = sorted(
        all_recent_transactions, key=lambda txn: txn["date"], reverse=True
    )
    print(f"sort_transactions: {sorted_all_recent_transactions}")
    return sorted_all_recent_transactions
