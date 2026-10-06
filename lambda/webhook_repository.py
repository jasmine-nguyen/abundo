from botocore.exceptions import ClientError
from boto3.dynamodb.conditions import Attr, Key
from typing import Any, Callable, Optional
import reconcile
from models import Transaction
from constants import PENDING_STATUS, POSTED_STATUS
from repository_base import db_errors, handle_database_error
from repository_transaction import (
    TransactionRepository as _SharedTransactionRepository,
    _build_pk,
    _build_sk,
)


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

    def get_pending_transactions_for_account(self, account_id: str) -> list[dict]:
        """Retrieves all pending transactions of an account using the account_id.

        Follows pagination (WHIT-82) via _paginated_query: a pending row beyond the first
        1MB page must stay visible to reconciliation, else a silent duplicate + lost category.
        """
        return self._paginated_query(
            key_condition=Key("pk").eq(_build_pk(account_id)),
            filter_expression=Attr("status").eq(PENDING_STATUS),
        )

    def get_posted_transactions_for_account(self, account_id: str) -> list[dict]:
        """Retrieves all posted (settled) transactions of an account.

        Same paginated per-account query as get_pending, only the status filter differs. Used by
        the age-out rescue (WHIT-511), which scans an account's posted rows for the settled twin
        of a filed pending it is about to reap.
        """
        return self._paginated_query(
            key_condition=Key("pk").eq(_build_pk(account_id)),
            filter_expression=Attr("status").eq(POSTED_STATUS),
        )

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

        # One pending scan per account that has a first-time settlement to match.
        accounts = dict.fromkeys(t["account_id"] for t in posted_txns
                                 if t["transaction_id"] not in stored_rows)
        pending_pools = {account_id: self.get_pending_transactions_for_account(account_id)
                         for account_id in accounts}

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
                    if not self._update_bank_fields(own_pk, own_sk, txn, inherit_date_from=inherit_date_from):
                        to_insert.append(txn)
                case ("settle", txn, twin):
                    fresh = self._refresh_carried_fields(twin)
                    to_insert.append(reconcile.settle(txn, fresh, is_unfiled))
                case ("insert", txn):
                    to_insert.append(txn)

        self.insert_transactions(to_insert)
        for pk, sk in plan.stale_pending_keys:
            self.delete_pending_if_present(pk, sk)

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

        names: dict[str, str] = {}
        values: dict[str, Any] = {}
        set_clauses: list[str] = []
        for index, (field, value) in enumerate(updates.items()):
            names[f"#b{index}"] = field
            values[f":b{index}"] = value
            set_clauses.append(f"#b{index} = :b{index}")

        update_kwargs: dict[str, Any] = {
            "Key": {"pk": pk, "sk": sk},
            "UpdateExpression": "SET " + ", ".join(set_clauses),
            "ExpressionAttributeNames": names,
            "ExpressionAttributeValues": values,
            "ConditionExpression": "attribute_exists(pk)",
        }

        try:
            self._get_table().update_item(**update_kwargs)
            return True
        except ClientError as e:
            if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return False
            handle_database_error(e, "write")

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
        write succeeds; a plain, idempotent put — re-marking is harmless."""
        with db_errors("mark_event"):
            self._get_table().put_item(
                Item={"pk": f"EVENT#{envelope_id}", "sk": "EVENT"}
            )
