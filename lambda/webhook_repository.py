import time
from datetime import timedelta
from boto3.dynamodb.conditions import Attr, Key
from typing import Any, Callable, Optional
import reconcile
from models import Transaction
from constants import EVENT_MARKER_TTL_SECONDS, PENDING_LOOKBACK_DAYS, PENDING_STATUS, SETTLED_PENDING_TTL_SECONDS
from repository_base import conditional_write, db_errors, logger, update_expression
from repository_transaction import (
    TransactionRepository as _SharedTransactionRepository,
    _build_pk,
    _build_sk,
    read_date_range_pages,
)
from spend import melbourne_today


def _build_settled_pk(account_pk: str) -> str:
    return f"SETTLED#{account_pk}"


class TransactionRepository(_SharedTransactionRepository):
    """The webhook's transaction store. Inherits the generic CRUD (table config,
    insert/batch/failed-record writes) from shared/repository_transaction.py and
    adds the webhook-only reconcile pipeline below (WHIT-454 removed the duplicated
    copies of the inherited methods)."""

    def get_transaction(self, pk: str, sk: str, *, consistent: bool = False) -> Optional[dict[str, Any]]:
        """Retrieves a single record document. Returns None if it is missing."""
        with db_errors("read"):
            response = self._get_table().get_item(
                Key={"pk": pk, "sk": sk}, ConsistentRead=consistent,
            )
            # Absent is a normal result — the reconcile paths read here to check for an
            # existing row on every pending/posted re-send, so a miss is the common
            # first-sight case, not something to log (WHIT-329).
            return response.get("Item") or None

    def get_account_transactions(self, account_id: str, status: str) -> list[dict]:
        """Retrieves all of an account's transactions with this status (pending or posted).

        Reads the whole account, so only the daily age-out uses it: its job is to find the
        OLD pendings. Follows pagination (WHIT-82) via _paginated_query.
        """
        return self._paginated_query(
            key_condition=Key("pk").eq(_build_pk(account_id)),
            filter_expression=Attr("status").eq(status),
        )

    def get_pending_pools(self, transactions: list[Transaction]) -> dict[str, list[dict]]:
        """The recent pendings of every account with a non-pending row in `transactions` — the
        pool reconcile matches settlements against. Read once per bank message and shared by
        the alert preview and the write, so both see the same pool (ABU-41). Bounded to the
        last PENDING_LOOKBACK_DAYS through the date-index; age-out reaps anything older."""
        start = (melbourne_today() - timedelta(days=PENDING_LOOKBACK_DAYS)).isoformat()
        accounts = dict.fromkeys(t["account_id"] for t in transactions if t.get("status") != PENDING_STATUS)
        return {
            account_id: [row for row in read_date_range_pages(self, account_id, start, None)
                         if row.get("status") == PENDING_STATUS]
            for account_id in accounts
        }

    def get_failed_transactions(self) -> list[dict]:
        """Retrieve all dead-lettered rows — the ``pk="FAILED"`` partition written by
        save_failed_transactions. Paginated (WHIT-82 pattern) so a large backlog isn't
        truncated at DynamoDB's 1MB page. Read-only; the reprocess sweep (WHIT-55)
        drives it."""
        return self._paginated_query(key_condition=Key("pk").eq("FAILED"))

    def delete_failed_transaction(self, sk: str) -> None:
        """Delete a dead-letter row after it has been successfully reprocessed
        (WHIT-55). No attribute_exists guard, so a re-run deleting an already-gone row
        is a harmless no-op (mirrors delete_pending_if_present)."""
        with db_errors("delete failed"):
            self._get_table().delete_item(Key={"pk": "FAILED", "sk": sk})

    def insert_or_reconcile(
        self, transactions: list[Transaction], *,
        is_unfiled: Optional[Callable[[Optional[str]], bool]] = None,
        pending_pools: Optional[dict[str, list[dict]]] = None,
    ) -> None:
        """Insert transactions, reconciling pending->posted so a user's category
        survives settlement.

        On settlement BankSync issues a NEW id for the posted transaction with no
        link back to the pending one (`pendingTransactionId` is null today), so a
        blind insert would leave two rows — a categorized pending + an uncategorized
        posted. Instead, for each POSTED transaction we find its pending twin, carry
        the pending row's `category` onto the posted row, and delete the stale
        pending. Match order per posting (see the reconcile._find_*_twin tiers): exact
        `pending_transaction_id` link (forward-compat), else same authorized_date +
        EXACT amount, else a tip-adjusted match (same day + merchant + amount within
        TIP_HEADROOM above the auth), else a skewed-date match (WHIT-331: pending dated
        exactly one day later + exact amount + merchant, for a pair ANZ split across the
        Melbourne/UTC day boundary), else a blank-authorized_date match, else a same-id
        re-sync of an already-stored posted row. No match -> a plain insert. A
        missing/racey match never raises: it degrades to insert.

        WHIT-117: across a MULTI-ROW batch the twin search runs a pass per tier (all
        exact matches resolved before any looser tier — see reconcile.match_all) so an
        exact twin is never starved by a tip- or skew-eligible sibling posting processed
        first.

        Pending rows are inserted as-is. All inserts are batched at the end; stale
        pendings are deleted after.

        WHIT-545: `is_unfiled` (the caller's taxonomy check) gates the first-settlement
        carry so a stored raw category can't clobber a rule-fill, and recomputes
        counts_to_budget for the carried category. Absent -> the carry is unchanged.

        `pending_pools`: the caller's get_pending_pools read, so the alert preview and the
        write share one read (ABU-41). Absent -> read here.
        """
        if not transactions:
            return

        # A posted row already stored under its OWN id is a re-send, not a settlement: the
        # plan updates it in place and keeps it out of the twin search (WHIT-331).
        posted_txns = [t for t in transactions if t.get("status") != PENDING_STATUS]
        stored_rows: dict[str, dict] = {}
        for posted_txn in posted_txns:
            stored = self.get_transaction(_build_pk(posted_txn["account_id"]),
                                          _build_sk(posted_txn["transaction_id"]))
            if stored is not None:
                stored_rows[posted_txn["transaction_id"]] = stored

        if pending_pools is None:
            pending_pools = self.get_pending_pools(transactions)

        plan = reconcile.plan_reconcile(transactions, stored_rows, pending_pools)

        to_insert: list[Transaction] = []
        for step in plan.steps:
            match step:
                case ("update", txn, inherit_date_from):
                    # WHIT-513: partial update — only overwrite bank-owned fields, so the
                    # user's category/notes/tags/budget_excluded stay untouched. Falls back
                    # to a plain insert when the row doesn't exist yet.
                    own_pk = _build_pk(txn["account_id"])
                    own_sk = _build_sk(txn["transaction_id"])
                    if self._update_bank_fields(own_pk, own_sk, txn, inherit_date_from=inherit_date_from):
                        continue
                    if txn.get("status") == PENDING_STATUS and self._pending_was_removed(txn):
                        logger.info("skipped re-sent pending %s: settled or deleted while in flight",
                                    txn["transaction_id"])
                        continue
                    to_insert.append(txn)
                case ("settle", txn, twin):
                    fresh = self._refresh_carried_fields(twin)
                    to_insert.append(reconcile.settle(txn, fresh, is_unfiled))
                case ("insert", txn):
                    to_insert.append(txn)

        self.insert_transactions(to_insert)
        for pk, sk in plan.stale_pending_keys:
            self.mark_settled(pk, sk)
            self.delete_pending_if_present(pk, sk)

    def _pending_was_removed(self, txn: Transaction) -> bool:
        """Whether a pending's row vanished because it was settled or deleted by the user (ABU-36).
        Read consistently: the settle writes its marker before deleting the row, so a failed update
        after that delete always sees the marker."""
        account_id, transaction_id = txn["account_id"], txn["transaction_id"]
        return (self.is_settled(account_id, transaction_id, consistent=True)
                or self.is_deleted(account_id, transaction_id, consistent=True))

    def mark_settled(self, pk: str, sk: str) -> None:
        """Record that the pending at (pk, sk) was used up by its posted twin, so a re-send can't
        bring it back (ABU-36). Written before the pending is deleted; expires via `expires_at`."""
        with db_errors("mark settled"):
            self._get_table().put_item(Item={
                "pk": _build_settled_pk(pk),
                "sk": sk,
                "expires_at": int(time.time()) + SETTLED_PENDING_TTL_SECONDS,
            })

    def is_settled(self, account_id: str, transaction_id: str, *, consistent: bool = False) -> bool:
        """True while the settled marker for this pending hasn't expired."""
        key = {"pk": _build_settled_pk(_build_pk(account_id)), "sk": _build_sk(transaction_id)}
        with db_errors("read"):
            return "Item" in self._get_table().get_item(Key=key, ConsistentRead=consistent)

    def _refresh_carried_fields(self, twin: dict) -> dict:
        """Re-read a matched twin with ConsistentRead to close the race window (WHIT-513).

        Between the initial pool scan (eventually consistent) and now, the user may
        have categorised / noted the pending. A stale read would silently drop that
        edit. Returns the fresh row, or the original twin if the row is gone (the
        insert path's sanitise_transaction strips None, so a vanished twin degrades
        to a plain insert with no user fields — safe).
        """
        fresh = self.get_transaction(twin["pk"], twin["sk"], consistent=True)
        return fresh if fresh is not None else twin

    def _update_bank_fields(
        self, pk: str, sk: str, txn: Transaction, *, inherit_date_from: Optional[dict] = None,
    ) -> bool:
        """Partial-update the bank-owned fields of an existing row (WHIT-513).

        Only touches the fields the bank sends (amount, description, status, etc.);
        user-owned fields (category, notes, tags, budget_excluded) stay untouched.
        Returns True on success, False if the row no longer exists.

        inherit_date_from: when set, date/authorized_date are taken from this row
        instead of from the incoming txn, via the same inherit-swipe-date logic.
        """
        updates = reconcile.bank_field_updates(txn, inherit_date_from)
        if not updates:
            return True

        expression, names, values = update_expression(updates)
        update_kwargs: dict[str, Any] = {
            "Key": {"pk": pk, "sk": sk},
            "UpdateExpression": expression,
            "ExpressionAttributeNames": names,
            "ExpressionAttributeValues": values,
            "ConditionExpression": "attribute_exists(pk)",
        }

        return conditional_write("write", lambda: self._get_table().update_item(**update_kwargs))

    def delete_pending_if_present(self, pk: str, sk: str) -> None:
        """Delete a stale pending row. No attribute_exists guard, so deleting an
        already-gone row is a harmless no-op (avoids a race raising a 500)."""
        with db_errors("delete pending"):
            self._get_table().delete_item(Key={"pk": pk, "sk": sk})

    def has_event(self, envelope_id: str) -> bool:
        """Whether this event was already fully processed (its marker exists).

        The marker is written by mark_event only AFTER a delivery succeeds, so a
        failed delivery leaves no marker and BankSync's retry re-processes it — a
        failed write can never drop the transaction (WHIT-83, save-then-mark).
        """
        with db_errors("has_event"):
            result = self._get_table().get_item(
                Key={"pk": f"EVENT#{envelope_id}", "sk": "EVENT"}
            )
            return "Item" in result

    def mark_event(self, envelope_id: str) -> None:
        """Record that an event has been fully processed. Called only after the
        write succeeds; a plain, idempotent put — re-marking is harmless.
        The marker auto-expires (`expires_at`) once BankSync can no longer re-send it."""
        with db_errors("mark_event"):
            self._get_table().put_item(
                Item={
                    "pk": f"EVENT#{envelope_id}",
                    "sk": "EVENT",
                    "expires_at": int(time.time()) + EVENT_MARKER_TTL_SECONDS,
                }
            )
