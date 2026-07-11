"""Push-receipt id stash (WHIT-139) — the capture half of the "receipts" phase.

Expo push delivery is async: ``send_push`` (shared/push.py) gets a ticket per
ACCEPTED message carrying a receipt id, but a token may only be revealed as
unregistered — or a delivery failure surfaced — LATER, via Expo's receipts endpoint.
This stash records each ``{receipt_id -> token}`` so a later scheduled sweep can poll
Expo for the true delivery outcome, prune dead tokens, and alarm on silent failures.
(The sweep itself is a follow-up; this module is only the write side.)

Layout: one item per receipt id, grouped under a SINGLE partition
``pk="PUSHRECEIPT#PENDING"``, ``sk=<receipt_id>``, attr ``token``. The shared partition
lets the sweep Query every pending id in one call instead of scanning the table. Each
write sets an ``expires_at`` epoch-seconds TTL so an id that is never resolved (Expo
retains receipts ~24h) self-cleans instead of accumulating.

The TTL is defined LOCALLY (not imported from the shared ``constants`` module) so this
module doesn't trip the constants-shadow guard (lambda_api/constants.py) — mirroring
how shared/push.py keeps its Expo constants local.
"""

import time
from typing import Any

import boto3
from botocore.exceptions import ClientError

from repository_base import REGION_NAME, TABLE_NAME, handle_database_error

# All pending receipt ids share one partition so the sweep Queries them in a single
# call; a per-id partition would force a full-table Scan.
_PENDING_PK = "PUSHRECEIPT#PENDING"

# A stashed receipt id self-expires after ~24h — Expo retains receipts about that long,
# so an id the sweep never resolves is reaped by TTL rather than left forever.
RECEIPT_TTL_SECONDS = 24 * 60 * 60


class PushReceiptRepository:
    """Stashes ``{receipt_id -> token}`` pairs for the later Expo-receipts sweep."""

    def __init__(self) -> None:
        self._dynamodb = None
        self._table = None

    def _get_table(self) -> Any:
        if self._table is None:
            self._dynamodb = boto3.resource("dynamodb", region_name=REGION_NAME)
            self._table = self._dynamodb.Table(TABLE_NAME)
        return self._table

    def put(self, receipt_id: str, token: str) -> None:
        """Stash one receipt id with the token its push went to, setting a fresh TTL.
        Re-putting the same id is harmless (same token), and the write is idempotent."""
        try:
            self._get_table().put_item(
                Item={
                    "pk": _PENDING_PK,
                    "sk": receipt_id,
                    "token": token,
                    "expires_at": int(time.time()) + RECEIPT_TTL_SECONDS,
                }
            )
        except ClientError as e:
            handle_database_error(e, "stash push receipt id")
