"""AWS Lambda entry point for syncing BankSync transactions into DynamoDB."""

import base64
from banksync import BankSyncClient, UnknownAccountError
from botocore.exceptions import ClientError
from models import Transaction
from repository import TransactionRepository
from standardwebhooks.webhooks import Webhook
from ssm import get_param

# account ids for ANZ, Up Spending, Up Homeloan, hardcoded as they are rarely changed
ACCOUNT_ID_MAP = {
    "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0": "anz-rewards-black-visa",
    "3zVQJ8Btz_IRmqp78VrQnQ": "up-spending",
    "T6d8ppsYssBDFCwl1qEb0w": "up-homeloan",
}
BANKSYNC_WEBHOOK_SECRET_PATH = "/whittle/banksync-webhook-secret"

_webhook_signing_secret = None


def get_webhook_signing_secret() -> str:
    global _webhook_signing_secret
    if _webhook_signing_secret is None:
        _webhook_signing_secret = get_param(BANKSYNC_WEBHOOK_SECRET_PATH)
    return _webhook_signing_secret


def verify_and_parse(event) -> dict:
    raw_body = event.get("body", "")
    if event.get("isBase64Encoded"):
        raw_body = base64.b64decode(raw_body).decode("utf-8")
    wh = Webhook(get_webhook_signing_secret())

    normalized_headers = {k.lower(): v for k, v in event.get("headers", {}).items()}
    return wh.verify(raw_body, normalized_headers)


def lambda_handler(event, context):
    """Lambda handler: runs a full sync and returns a 200 response.

    `event` and `context` are supplied by the AWS Lambda runtime and are unused
    because the sync is driven entirely by the hardcoded account list.
    """
    repo = TransactionRepository()
    try:
        payload = verify_and_parse(event)
    except Exception:
        return {"statusCode": 401, "body": "invalid signature"}

    if not repo.is_new_event(payload["id"]):
        return {"statusCode": 200, "body": "duplicate event - skipped"}

    # new event -> process_transaction
    try:
        process_transaction(payload, repo)
        return {"statusCode": 200, "body": "ok"}
    except Exception as e:
        return {
            "statusCode": 500,
            "body": str(e),
        }


def process_transaction(payload: dict, repo: TransactionRepository):
    normalised_transactions: list[Transaction] = []
    print(f"normalised_transactions: {normalised_transactions}")
    unmapped_transactions: list[dict] = []
    for row in payload["data"]:
        try:
            normalised_transactions.append(BankSyncClient.normalise(row))
        except (UnknownAccountError, KeyError):
            unmapped_transactions.append(row)

    # dead-letter unmapped_transactions

    try:
        repo.insert_transactions(normalised_transactions)
    except ClientError:
        return {"statusCode": 500, "body": "transaction insertion failed"}


#
# def sync(repo: TransactionRepository, client: PocketSmithClient) -> None:
#     """Sync every configured account, fetching only transactions changed since
#     the most recent one already stored for that account."""
#     for account_id in ACCOUNT_ID_MAP.keys():
#         print(f"Fetching account {account_id}")
#         transactions = client.get_transactions(account_id, updated_since)
#         for txn in transactions:
#             process_transaction(repo, txn)
#

# def process_transaction(repo: TransactionRepository, txn: Transaction) -> None:
#     """Route a single transaction to the correct write action.
#
#     Three cases are handled:
#       1. The transaction already exists -> update its status if it changed.
#       2. A new `pending` transaction -> insert it as-is.
#       3. A new `posted` transaction -> reconcile it with a matching pending
#          transaction if one exists, otherwise insert it.
#     """
#     keys = repo.get_transaction_keys_by_id(txn["transaction_id"])
#     if keys is not None:
#         # Already stored: the only thing that can change is the status flag.
#         existing_txn = repo.get_transaction(keys["pk"], keys["sk"])
#         if existing_txn and existing_txn["status"] != txn["status"]:
#             repo.update_transaction_status(keys["pk"], keys["sk"], txn["status"])
#         return
#
#     if txn["status"] == PENDING_STATUS:
#         repo.insert_transaction(txn)
#         return
#
#     # Posted transaction we haven't seen by id: it may be the settled version of
#     # an earlier pending row, so try to reconcile before inserting a duplicate.
#     match = find_pending_match(repo, txn)
#     if match:
#         repo.reconcile_and_replace(match["pk"], match["sk"], txn)
#     else:
#         repo.insert_transaction(txn)
#
#
# def find_pending_match(repo: TransactionRepository, txn: Transaction) -> Optional[dict]:
#     """Return the stored pending transaction that corresponds to `txn`, or None.
#
#     Used to pair a newly posted transaction with the pending row it settles, so
#     the two can be merged instead of duplicated.
#     """
#     pending_transactions = repo.get_pending_transactions_for_account(txn["account_id"])
#     for pending_txn in pending_transactions:
#         if is_same_transaction(pending_txn, txn):
#             return pending_txn
#     return None
#
#
# def is_same_transaction(old_txn: Mapping[str, Any], new_txn: Mapping[str, Any]) -> bool:
#     """Decide whether two transactions represent the same real-world purchase.
#
#     Account, amount and closing balance must match exactly; the payee only needs
#     to be a fuzzy match because the merchant string often differs slightly
#     between the pending and posted versions.
#     """
#     account_id_match = new_txn["account_id"] == old_txn["account_id"]
#     amount_match = new_txn["amount"] == old_txn["amount"]
#     closing_balance_match = new_txn["closing_balance"] == old_txn["closing_balance"]
#     # Check the cheap exact-equality fields first so we only run the expensive
#     # fuzzy payee comparison on transactions that are otherwise identical.
#     if not account_id_match or not amount_match or not closing_balance_match:
#         return False
#
#     payee_matching_score = fuzz.partial_ratio(new_txn["payee"], old_txn["payee"])
#     return payee_matching_score > PAYEE_MATCH_THRESHOLD
