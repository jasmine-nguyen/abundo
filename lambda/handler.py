"""AWS Lambda entry point for syncing PocketSmith transactions into DynamoDB.

Each run pulls new/updated transactions per account from PocketSmith and
reconciles them against what is already stored. The core challenge is that a
transaction first appears as `pending` and later reappears as `posted` (often
with a different id), so this module detects and merges those duplicates rather
than storing both.
"""

from typing import Any, Mapping, Optional
from rapidfuzz import fuzz
from pocketsmith import PocketSmithClient, Transaction, PENDING_STATUS
from repository import TransactionRepository

# account ids for ANZ, Up Spending, Up Homeloan, hardcoded as they are rarely changed
ACCOUNT_IDS = ["5256839", "5256787", "5256791"]
# Minimum fuzzy-match score (0-100) for two payee strings to be treated as the
# same merchant when reconciling a pending transaction with its posted version.
PAYEE_MATCH_THRESHOLD = 80.0


def handler(event, context):
    """Lambda handler: runs a full sync and returns a 200 response.

    `event` and `context` are supplied by the AWS Lambda runtime and are unused
    because the sync is driven entirely by the hardcoded account list.
    """
    repo = TransactionRepository()
    client = PocketSmithClient()
    sync(repo=repo, client=client)
    return {"statusCode": 200, "body": "ok"}


def sync(repo: TransactionRepository, client: PocketSmithClient) -> None:
    """Sync every configured account, fetching only transactions changed since
    the most recent one already stored for that account."""
    for account_id in ACCOUNT_IDS:
        # Only request transactions updated after our latest stored one to keep
        # each sync incremental rather than re-fetching the full history.
        updated_since = repo.get_latest_updated_at(account_id)
        transactions = client.get_transactions(account_id, updated_since)
        for txn in transactions:
            process_transaction(repo, txn)


def process_transaction(repo: TransactionRepository, txn: Transaction) -> None:
    """Route a single transaction to the correct write action.

    Three cases are handled:
      1. The transaction already exists -> update its status if it changed.
      2. A new `pending` transaction -> insert it as-is.
      3. A new `posted` transaction -> reconcile it with a matching pending
         transaction if one exists, otherwise insert it.
    """
    keys = repo.get_transaction_keys_by_id(txn["transaction_id"])
    if keys is not None:
        # Already stored: the only thing that can change is the status flag.
        existing_txn = repo.get_transaction(keys["pk"], keys["sk"])
        if existing_txn and existing_txn["status"] != txn["status"]:
            repo.update_transaction_status(keys["pk"], keys["sk"], txn["status"])
        return

    if txn["status"] == PENDING_STATUS:
        repo.insert_transaction(txn)
        return

    # Posted transaction we haven't seen by id: it may be the settled version of
    # an earlier pending row, so try to reconcile before inserting a duplicate.
    match = find_pending_match(repo, txn)
    if match:
        repo.reconcile_and_replace(match["pk"], match["sk"], txn)
    else:
        repo.insert_transaction(txn)


def find_pending_match(repo: TransactionRepository, txn: Transaction) -> Optional[dict]:
    """Return the stored pending transaction that corresponds to `txn`, or None.

    Used to pair a newly posted transaction with the pending row it settles, so
    the two can be merged instead of duplicated.
    """
    pending_transactions = repo.get_pending_transactions_for_account(txn["account_id"])
    for pending_txn in pending_transactions:
        if is_same_transaction(pending_txn, txn):
            return pending_txn
    return None


def is_same_transaction(old_txn: Mapping[str, Any], new_txn: Mapping[str, Any]) -> bool:
    """Decide whether two transactions represent the same real-world purchase.

    Account, amount and closing balance must match exactly; the payee only needs
    to be a fuzzy match because the merchant string often differs slightly
    between the pending and posted versions.
    """
    account_id_match = new_txn["account_id"] == old_txn["account_id"]
    amount_match = new_txn["amount"] == old_txn["amount"]
    closing_balance_match = new_txn["closing_balance"] == old_txn["closing_balance"]
    # Check the cheap exact-equality fields first so we only run the expensive
    # fuzzy payee comparison on transactions that are otherwise identical.
    if not account_id_match or not amount_match or not closing_balance_match:
        return False

    payee_matching_score = fuzz.partial_ratio(new_txn["payee"], old_txn["payee"])
    return payee_matching_score > PAYEE_MATCH_THRESHOLD
