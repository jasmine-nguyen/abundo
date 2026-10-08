"""Transaction storage: the per-account transaction rows plus the failed-record
and idempotency-event helpers used by the sync/webhook pipeline."""

import json
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from boto3.dynamodb.conditions import Key

from constants import (
    ACCOUNT_ID_MAP,
    DATE_RANGE_MAX_PAGES,
    DEAD_LETTER_TTL_SECONDS,
    DELETED_TRANSACTION_TTL_SECONDS,
    MAX_PAGE_SIZE,
    PENDING_STATUS,
)
from models import Transaction
from repository_base import RepositoryBase, conditional_write, db_errors, logger, update_expression

# Sentinel for update_transaction_fields: distinguishes "field not in this request"
# (leave it untouched) from "clear this field" (None/""/[]). A plain None can't do
# that — None is a legitimate "clear" value.
_UNSET = object()


def sanitise_transaction(txn: Transaction) -> dict[str, Any]:
    """Strips out unassigned None properties to keep DynamoDB documents sparse."""
    return {k: v for k, v in txn.items() if v is not None}


def read_date_range_pages(
    repo: Any,
    account_id: str,
    start: Optional[str],
    end: Optional[str],
    max_pages: int = DATE_RANGE_MAX_PAGES,
) -> list[dict[str, Any]]:
    """Every row for `account_id` in [start, end], following the date-index cursor to
    the last page. A cursor still going after `max_pages` means it isn't advancing, so
    raise rather than loop until the Lambda times out."""
    rows: list[dict[str, Any]] = []
    cursor = None
    for _ in range(max_pages):
        page, cursor = repo.get_transactions_by_date_range(account_id, start, end, MAX_PAGE_SIZE, cursor)
        rows.extend(page)
        if not cursor:
            return rows
    raise RuntimeError(
        f"date-range read for {account_id} did not finish after {max_pages} pages ({start}..{end})"
    )


def read_window(repo: Any, start: Optional[str], end: Optional[str]) -> list[dict[str, Any]]:
    """Every row in [start, end] across all the mapped accounts."""
    rows: list[dict[str, Any]] = []
    for account_id in ACCOUNT_ID_MAP.values():
        rows.extend(read_date_range_pages(repo, account_id, start, end))
    return rows


def _build_pk(account_id: str) -> str:
    return f"ACCOUNT#{account_id}"


def _build_sk(transaction_id: str) -> str:
    return f"TXN#{transaction_id}"


def _build_deleted_pk(account_pk: str) -> str:
    return f"DELETED#{account_pk}"


class TransactionRepository(RepositoryBase):
    def insert_transactions(self, transactions: list[Transaction]) -> None:
        """Inserts multiple transactions efficiently using DynamoDB Batch Write."""
        if not transactions:
            return
        items = []

        for transaction in transactions:
            item = {
                "pk": _build_pk(transaction["account_id"]),
                "sk": _build_sk(transaction["transaction_id"]),
                **sanitise_transaction(transaction),
            }
            items.append(item)

        self._batch_put(items, "batch_write")

    def save_failed_transactions(self, failed_transactions: list[dict]) -> None:
        """Inserts failed transactions using DynamoDB Batch Write."""
        if not failed_transactions:
            return

        items = []
        for transaction in failed_transactions:
            now = datetime.now(timezone.utc)
            item = {
                "pk": "FAILED",
                "sk": f"{now.isoformat()}#{uuid.uuid4()}",
                "raw": json.dumps(transaction),
                # failed_at: readable "how long stuck". expires_at: DynamoDB TTL
                # (epoch seconds) so old dead-letter rows auto-expire (WHIT-54).
                "failed_at": now.isoformat(),
                "expires_at": int(now.timestamp()) + DEAD_LETTER_TTL_SECONDS,
            }
            items.append(item)
        self._batch_put(items, "save_failed_transactions")

    def _batch_put(self, items: list[dict], action: str) -> None:
        if not items:
            return
        with db_errors(action):
            table = self._get_table()
            with table.batch_writer() as batch:
                for item in items:
                    batch.put_item(Item=item)

    def get_transactions_by_date_range(
        self,
        account_id: str,
        start_date: Optional[str],
        end_date: Optional[str],
        limit: int = 20,
        cursor: Optional[dict[str, Any]] = None,
    ) -> tuple[list[dict[str, Any]], Optional[dict[str, Any]]]:
        if not account_id:
            return [], None

        # GSI keys hold RAW values — no ACCOUNT# / TXN# prefixes
        key_condition = Key("account_id").eq(account_id)

        if start_date and end_date:
            key_condition &= Key("date").between(start_date, end_date)
        elif start_date:
            key_condition &= Key("date").gte(start_date)
        # no dates → whole partition, newest-first

        query_kwargs = {
            "IndexName": "date-index",
            "KeyConditionExpression": key_condition,
            "ScanIndexForward": False,  # newest transaction first
            "Limit": min(limit, MAX_PAGE_SIZE),
        }
        if cursor:
            query_kwargs["ExclusiveStartKey"] = cursor

        with db_errors("read"):
            response = self._get_table().query(**query_kwargs)
            return response.get("Items", []), response.get("LastEvaluatedKey")

    def get_transaction_keys_by_id(
        self, transaction_id: str
    ) -> Optional[dict[str, str]]:
        """
        Queries the GSI to find the primary keys (pk and sk) for a given transaction_id.
        Returns a dict with {"pk": "...", "sk": "..."} if found, or None.
        """
        with db_errors("index query"):
            # Query the GSI instead of a table Scan
            response = self._get_table().query(
                IndexName="transaction-id-index",
                KeyConditionExpression=Key("transaction_id").eq(transaction_id),
            )

            items = response.get("Items", [])

            if not items:
                logger.debug(f"Transaction ID {transaction_id} not found in GSI.")
                return None

            if len(items) > 1:
                logger.warning(
                    f"Multiple records found for transaction_id {transaction_id}, using first match."
                )

            first_match = items[0]
            return {"pk": first_match["pk"], "sk": first_match["sk"]}

    def delete_transaction(self, pk: str, sk: str) -> bool:
        """Deletes a transaction the user removed, leaving a "deleted by you" marker (WHIT-654).

        The marker is written FIRST so a BankSync re-send can't bring the charge back; it carries
        no index fields, so no read lists it, and DynamoDB's TTL expires it. A stray marker from a
        failed delete is harmless. Returns False when the row is already gone (a 404).
        """
        now = int(datetime.now(timezone.utc).timestamp())
        with db_errors("delete"):
            self._get_table().put_item(Item={
                "pk": _build_deleted_pk(pk),
                "sk": sk,
                "expires_at": now + DELETED_TRANSACTION_TTL_SECONDS,
            })
        return conditional_write("delete", lambda: self._get_table().delete_item(
            Key={"pk": pk, "sk": sk}, ConditionExpression="attribute_exists(pk)"
        ))

    def delete_if_still_pending(self, pk: str, sk: str) -> bool:
        """Deletes a pending the bank no longer lists (WHIT-662). No "deleted by you" marker: the
        bank dropped it, the user didn't. Returns False when the row is gone or has since posted."""
        return conditional_write("delete", lambda: self._get_table().delete_item(
            Key={"pk": pk, "sk": sk},
            ConditionExpression="#s = :pending",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":pending": PENDING_STATUS},
        ))

    def carry_onto_pending(self, pk: str, sk: str, carried: Transaction) -> bool:
        """Write a carried edit onto a still-pending row (WHIT-678): its category, notes, tags,
        exclusion, rule stamp and budget flag. Never recreates the row. Returns False when the
        row is gone or has since posted."""
        fields = ("category", "notes", "tags", "budget_excluded", "filed_by_rule", "counts_to_budget")
        sets = {field: carried[field] for field in fields if carried.get(field) is not None}
        removes = ["filed_by_rule"] if carried.get("filed_by_rule") is None else []
        expression, names, values = update_expression(sets, removes)
        return conditional_write("write", lambda: self._get_table().update_item(
            Key={"pk": pk, "sk": sk},
            UpdateExpression=expression,
            ExpressionAttributeNames={**names, "#s": "status"},
            ExpressionAttributeValues={**values, ":pending": PENDING_STATUS},
            ConditionExpression="attribute_exists(pk) AND #s = :pending",
        ))

    def is_deleted(self, account_id: str, transaction_id: str) -> bool:
        """True while the user's "deleted by you" marker for this transaction hasn't expired."""
        key = {"pk": _build_deleted_pk(_build_pk(account_id)), "sk": _build_sk(transaction_id)}
        with db_errors("read"):
            return "Item" in self._get_table().get_item(Key=key)

    def update_transaction_category(self, pk: str, sk: str, category: str) -> bool:
        """Sets a transaction's category, leaving all other attributes intact.

        Uses a #c alias because 'category' is a reserved word in DynamoDB. The
        attribute_exists(pk) guard makes the write conditional on the row still
        existing: get_transaction_keys_by_id and this update are not atomic, so a
        row deleted in between yields ConditionalCheckFailedException, which we
        surface as False (a 404 for the caller) rather than a 500.
        """
        return conditional_write("write", lambda: self._get_table().update_item(
            Key={"pk": pk, "sk": sk},
            # Filing by hand clears any rule stamp (WHIT-536) — REMOVE of an absent
            # attribute is a harmless no-op on a never-stamped row.
            UpdateExpression="SET #c = :category REMOVE #p",
            ExpressionAttributeNames={"#c": "category", "#p": "filed_by_rule"},
            ExpressionAttributeValues={":category": category},
            ConditionExpression="attribute_exists(pk)",
        ))

    def update_transaction_category_if_unchanged(
        self, pk: str, sk: str, category: str, expected_category: Optional[str],
        filed_by_rule: Optional[str] = None, budget_excluded: bool = False,
    ) -> tuple[str, Optional[str]]:
        """Set a transaction's category ONLY IF it still holds `expected_category` (WHIT-508).

        The apply-rules pass reads all of history, decides, then writes — up to 15s later. An
        unconditional write there silently overwrites a category the user tapped in the gap; this
        makes the user's own tap win.

        Returns (status, current_category):
          ("written", category) — the row still held expected_category and now holds `category`.
          ("changed", current)  — the row exists but holds something else; NOTHING was written.
                                  `current` is what it holds now, so the CALLER can judge whether
                                  that counts as filed — only the caller knows the taxonomy.
          ("gone", None)        — the row no longer exists.

        `expected_category=None` means "the row had no category at all", so the condition is
        attribute_not_exists rather than a comparison against NULL: rows are sparse — insert
        strips None (sanitise_transaction) and clear_rule_fill REMOVEs a rule's category —
        so an unfiled row carries no category attribute.

        DynamoDB reports "deleted" and "changed underneath" with the SAME error, so on a refusal we
        read the row back to tell them apart. Getting that wrong matters: the caller reports a
        missing row as vanished, and the app then drops it from the list entirely. "gone" is
        therefore only ever returned on a clean, definite absence — a failed read raises.
        """
        sets = {"category": category}
        # A rule filed this (WHIT-536): stamp filed_by_rule alongside the category, in the one
        # conditional write, so the stamp can never land on a row the tap-wins guard rejected.
        if filed_by_rule is not None:
            sets["filed_by_rule"] = filed_by_rule
        # The winning rule keeps this charge out of the budget (WHIT-558): set budget_excluded in the
        # SAME conditional write, for the same reason. Only ever SET True — never write False — so a
        # user's hand-set exclusion is never cleared by a rule (the user's tap always wins).
        if budget_excluded:
            sets["budget_excluded"] = True
        expression, names, values = update_expression(sets)
        condition = "attribute_exists(pk) AND attribute_not_exists(#f0)"
        if expected_category is not None:
            condition = "attribute_exists(pk) AND #f0 = :expected"
            values[":expected"] = expected_category

        if conditional_write("write", lambda: self._get_table().update_item(
            Key={"pk": pk, "sk": sk},
            UpdateExpression=expression,
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
            ConditionExpression=condition,
        )):
            return "written", category

        # The write was refused, so find out which refusal it was. Strongly consistent because
        # the scan reads an index that cannot be — reading stale here would reintroduce the very
        # race this method exists to close.
        with db_errors("read"):
            item = self._get_table().get_item(
                Key={"pk": pk, "sk": sk}, ConsistentRead=True
            ).get("Item")
        if item is None:
            return "gone", None
        return "changed", item.get("category")

    def clear_rule_fill(self, pk: str, sk: str, rule_id: str) -> bool:
        """Undo a rule's fill on ONE charge: REMOVE its category AND stamp, but ONLY while the
        stamp still equals `rule_id` (WHIT-540).

        Used when a rule is deleted (undo its fills) and when an edited rule no longer matches a
        charge it used to file. Conditioning on the STAMP — not the category — is the tap-wins
        guard: a manual file REMOVEs the stamp (update_transaction_category / _fields, WHIT-536),
        so a charge the user has since hand-filed no longer carries `rule_id`, the condition fails,
        and their choice stands untouched. Returns False on that mismatch and on a vanished row (a
        best-effort no-op the caller can skip), True when the fill was cleared.
        """
        return conditional_write("write", lambda: self._get_table().update_item(
            Key={"pk": pk, "sk": sk},
            UpdateExpression="REMOVE #c, #p",
            ExpressionAttributeNames={"#c": "category", "#p": "filed_by_rule"},
            ExpressionAttributeValues={":rule_id": rule_id},
            ConditionExpression="attribute_exists(pk) AND #p = :rule_id",
        ))

    def refile_rule_fill(
        self, pk: str, sk: str, category: str, old_rule_id: str, new_rule_id: str
    ) -> bool:
        """Re-file ONE charge an edited rule already filed: SET its category to the rule's new
        target and re-key the stamp to the rule's (possibly new) id, but ONLY while the stamp
        still equals `old_rule_id` (WHIT-540).

        Same stamp condition, same reason as clear_rule_fill: it targets a charge BECAUSE the rule
        owns it (stamp == old id), so the guard must be the stamp, not the category — a user who
        hand-filed to the SAME category in the gap has had the stamp REMOVEd, so the condition
        fails and the re-file skips them. (The category guard that
        update_transaction_category_if_unchanged uses is right for the sweep — which files UNFILED
        charges — but it can't see a same-category tap on an already-filed charge.)
        `old_rule_id == new_rule_id` for an in-place edit (a target-only
        or cosmetic value change) — the stamp is rewritten to the same id, only the category moves.
        Returns False on a stamp mismatch or a vanished row, True when the charge was re-filed.
        """
        return conditional_write("write", lambda: self._get_table().update_item(
            Key={"pk": pk, "sk": sk},
            UpdateExpression="SET #c = :category, #p = :new",
            ExpressionAttributeNames={"#c": "category", "#p": "filed_by_rule"},
            ExpressionAttributeValues={":category": category, ":new": new_rule_id,
                                       ":old": old_rule_id},
            ConditionExpression="attribute_exists(pk) AND #p = :old",
        ))

    def update_transaction_fields(
        self,
        pk: str,
        sk: str,
        *,
        category=_UNSET,
        notes=_UNSET,
        tags=_UNSET,
        budget_excluded=_UNSET,
    ) -> bool:
        """Set/clear a transaction's user-editable fields, leaving others intact.

        Only fields explicitly passed (not _UNSET) are touched. A truthy value is
        SET; a cleared note ("") or empty tag list ([]) or budget_excluded=False is
        REMOVEd, so a cleared field reads back ABSENT. 'category' is the exception:
        it is set-only (matching the PATCH API contract), so a falsy category raises
        rather than clearing — a future contributor relaxing the handler's validation
        can't silently un-file a charge through this REMOVE branch. Rows are sparse and
        sanitise_transaction keeps falsy-non-None, so storing ""/[]/False would read
        back as an empty value. One UpdateItem can legally mix SET and REMOVE
        clauses. update_expression aliases every field ('category' is a reserved
        word). Conditional on
        the row still existing (attribute_exists(pk)): a row deleted between the key
        lookup and here yields False (a 404 for the caller), not a 500.
        """
        sets: dict[str, Any] = {}
        removes: list[str] = []
        for field, provided in (
            ("category", category),
            ("notes", notes),
            ("tags", tags),
            ("budget_excluded", budget_excluded),
        ):
            if provided is _UNSET:
                continue
            if field == "category" and not provided:
                raise ValueError("category is set-only; a falsy value cannot clear it")
            if provided:
                sets[field] = provided
            else:
                removes.append(field)

        # Filing by hand clears the rule stamp (WHIT-536): whenever the category is SET
        # (it is set-only — a clear is refused above), REMOVE filed_by_rule. A notes/tags/
        # budget-only edit leaves category _UNSET, so the stamp survives. REMOVE of an absent
        # stamp is a no-op.
        if category is not _UNSET:
            removes.append("filed_by_rule")

        # No field supplied (all _UNSET) — nothing to write. Return without issuing a
        # malformed empty-expression UpdateItem.
        if not sets and not removes:
            return True

        expression, names, values = update_expression(sets, removes)
        update_kwargs: dict[str, Any] = {
            "Key": {"pk": pk, "sk": sk},
            "UpdateExpression": expression,
            "ExpressionAttributeNames": names,
            "ConditionExpression": "attribute_exists(pk)",
        }
        if values:
            update_kwargs["ExpressionAttributeValues"] = values

        return conditional_write("write", lambda: self._get_table().update_item(**update_kwargs))

    def update_transaction_categories(
        self, updates: list[dict[str, str]]
    ) -> list[dict[str, str]]:
        """Set the category on many transactions, best-effort (WHIT-70).

        Each update is {"id", "category"}. Applied INDEPENDENTLY: resolve the row's
        keys via the GSI, then conditionally update, so one unknown or vanished id
        yields a per-item "not_found" rather than failing the whole batch. Returns
        [{"id", "status"}] in input order, status ∈ {"updated", "not_found"}. A
        partial UpdateItem loop (not batch_writer, which is put-only and would
        overwrite the whole row; not transact_write_items, whose all-or-nothing
        would let one stale id sink the entire sweep).
        """
        results: list[dict[str, str]] = []
        for item in updates:
            transaction_id = item["id"]
            keys = self.get_transaction_keys_by_id(transaction_id)
            if keys is None:
                results.append({"id": transaction_id, "status": "not_found"})
                continue
            updated = self.update_transaction_category(
                keys["pk"], keys["sk"], item["category"]
            )
            results.append(
                {"id": transaction_id, "status": "updated" if updated else "not_found"}
            )
        return results
