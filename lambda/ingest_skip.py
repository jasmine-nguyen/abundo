"""Which incoming BankSync rows are never stored — shared by the webhook and the retry job."""

import logging

from constants import PENDING_STATUS

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

SKIP_LOG = {
    "zero": "$0.00 transaction(s)",
    "deleted": "re-sent transaction(s) the user deleted",
    "settled": "re-sent pending(s) already settled",
}


def skip_reason(repo, transaction) -> str | None:
    """Why `transaction` must not be stored, or None to store it.

    A $0.00 row is information only (WHIT-705): e.g. Westpac's "FOREIGN FEE" rows, whose real fee
    is already folded into the purchase. A charge the user deleted must not come back through a
    BankSync re-send or a retry run (WHIT-654). $0 is checked first to save a database read.
    A pending its posted twin already settled must not come back either, or both count (ABU-36);
    only pendings are checked, since the settled marker only ever names a used-up pending.
    """
    if transaction["amount"] == 0:
        return "zero"
    if repo.is_deleted(transaction["account_id"], transaction["transaction_id"]):
        return "deleted"
    if transaction.get("status") == PENDING_STATUS and repo.is_settled(
            transaction["account_id"], transaction["transaction_id"]):
        return "settled"
    return None


def drop_skipped(repo, transactions: list) -> list:
    """The rows that may be stored, logging how many were skipped and why."""
    kept = []
    skipped = {}
    for transaction in transactions:
        reason = skip_reason(repo, transaction)
        if reason is None:
            kept.append(transaction)
            continue
        skipped[reason] = skipped.get(reason, 0) + 1
    for reason, count in skipped.items():
        logger.info("skipped %d %s", count, SKIP_LOG[reason])
    return kept
