"""Transaction storage: the per-account transaction rows plus the failed-record
and idempotency-event helpers used by the sync/webhook pipeline."""

import json
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from constants import DEAD_LETTER_TTL_SECONDS, MAX_PAGE_SIZE
from models import Transaction
from repository_base import REGION_NAME, TABLE_NAME, handle_database_error, logger

# Sentinel for update_transaction_fields: distinguishes "field not in this request"
# (leave it untouched) from "clear this field" (None/""/[]). A plain None can't do
# that — None is a legitimate "clear" value.
_UNSET = object()


def sanitise_transaction(txn: Transaction) -> dict[str, Any]:
    """Strips out unassigned None properties to keep DynamoDB documents sparse."""
    return {k: v for k, v in txn.items() if v is not None}


def _build_pk(account_id: str) -> str:
    return f"ACCOUNT#{account_id}"


def _build_sk(transaction_id: str) -> str:
    return f"TXN#{transaction_id}"


class TransactionRepository:
    def __init__(self) -> None:
        self._dynamodb = None
        self._table = None

    def _get_table(self) -> Any:
        """Lazy-loads and buffers the connection to the physical DynamoDB table resource."""
        if self._table is None:
            self._dynamodb: Any = boto3.resource("dynamodb", region_name=REGION_NAME)
            self._table = self._dynamodb.Table(TABLE_NAME)
        return self._table

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
        try:
            table = self._get_table()
            with table.batch_writer() as batch:
                for item in items:
                    batch.put_item(Item=item)
        except ClientError as e:
            handle_database_error(e, action)

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

        try:
            response = self._get_table().query(**query_kwargs)
            return response.get("Items", []), response.get("LastEvaluatedKey")
        except ClientError as e:
            handle_database_error(e, "read")

    def get_transaction_keys_by_id(
        self, transaction_id: str
    ) -> Optional[dict[str, str]]:
        """
        Queries the GSI to find the primary keys (pk and sk) for a given transaction_id.
        Returns a dict with {"pk": "...", "sk": "..."} if found, or None.
        """
        try:
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

        except ClientError as e:
            handle_database_error(e, "index query")

    def update_transaction_category(self, pk: str, sk: str, category: str) -> bool:
        """Sets a transaction's category, leaving all other attributes intact.

        Uses a #c alias because 'category' is a reserved word in DynamoDB. The
        attribute_exists(pk) guard makes the write conditional on the row still
        existing: get_transaction_keys_by_id and this update are not atomic, so a
        row deleted in between yields ConditionalCheckFailedException, which we
        surface as False (a 404 for the caller) rather than a 500.
        """
        try:
            self._get_table().update_item(
                Key={"pk": pk, "sk": sk},
                # Filing by hand clears any rule stamp (WHIT-536) — REMOVE of an absent
                # attribute is a harmless no-op on a never-stamped row.
                UpdateExpression="SET #c = :category REMOVE #p",
                ExpressionAttributeNames={"#c": "category", "#p": "filed_by_rule"},
                ExpressionAttributeValues={":category": category},
                ConditionExpression="attribute_exists(pk)",
            )
            return True
        except ClientError as e:
            if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return False
            handle_database_error(e, "write")

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
        strips None (sanitise_transaction) and update_transaction_fields REMOVEs a cleared field —
        so an unfiled row carries no category attribute.

        DynamoDB reports "deleted" and "changed underneath" with the SAME error, so on a refusal we
        read the row back to tell them apart. Getting that wrong matters: the caller reports a
        missing row as vanished, and the app then drops it from the list entirely. "gone" is
        therefore only ever returned on a clean, definite absence — a failed read raises.
        """
        condition = "attribute_exists(pk) AND attribute_not_exists(#c)"
        names = {"#c": "category"}
        values = {":category": category}
        assignments = ["#c = :category"]
        if expected_category is not None:
            condition = "attribute_exists(pk) AND #c = :expected"
            values[":expected"] = expected_category
        # A rule filed this (WHIT-536): stamp filed_by_rule alongside the category, in the one
        # conditional write, so the stamp can never land on a row the tap-wins guard rejected.
        if filed_by_rule is not None:
            names["#p"] = "filed_by_rule"
            values[":rule"] = filed_by_rule
            assignments.append("#p = :rule")
        # The winning rule keeps this charge out of the budget (WHIT-558): set budget_excluded in the
        # SAME conditional write, for the same reason. Only ever SET True — never write False — so a
        # user's hand-set exclusion is never cleared by a rule (the user's tap always wins).
        if budget_excluded:
            names["#b"] = "budget_excluded"
            values[":bexcl"] = True
            assignments.append("#b = :bexcl")
        update_expression = "SET " + ", ".join(assignments)

        try:
            self._get_table().update_item(
                Key={"pk": pk, "sk": sk},
                UpdateExpression=update_expression,
                ExpressionAttributeNames=names,
                ExpressionAttributeValues=values,
                ConditionExpression=condition,
            )
            return "written", category
        except ClientError as e:
            if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
                handle_database_error(e, "write")
            # Fall through: the write was refused, so find out which refusal it was. Strongly
            # consistent because the scan reads an index that cannot be — reading stale here would
            # reintroduce the very race this method exists to close.

        try:
            item = self._get_table().get_item(
                Key={"pk": pk, "sk": sk}, ConsistentRead=True
            ).get("Item")
        except ClientError as e:
            handle_database_error(e, "read")
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
        try:
            self._get_table().update_item(
                Key={"pk": pk, "sk": sk},
                UpdateExpression="REMOVE #c, #p",
                ExpressionAttributeNames={"#c": "category", "#p": "filed_by_rule"},
                ExpressionAttributeValues={":rule_id": rule_id},
                ConditionExpression="attribute_exists(pk) AND #p = :rule_id",
            )
            return True
        except ClientError as e:
            if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return False
            handle_database_error(e, "write")

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
        try:
            self._get_table().update_item(
                Key={"pk": pk, "sk": sk},
                UpdateExpression="SET #c = :category, #p = :new",
                ExpressionAttributeNames={"#c": "category", "#p": "filed_by_rule"},
                ExpressionAttributeValues={":category": category, ":new": new_rule_id,
                                           ":old": old_rule_id},
                ConditionExpression="attribute_exists(pk) AND #p = :old",
            )
            return True
        except ClientError as e:
            if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return False
            handle_database_error(e, "write")

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
        clauses. Fields are aliased (a single #f/#v scheme) because 'category' is a
        reserved word; aliasing all four keeps the builder uniform. Conditional on
        the row still existing (attribute_exists(pk)): a row deleted between the key
        lookup and here yields False (a 404 for the caller), not a 500.
        """
        names: dict[str, str] = {}
        values: dict[str, Any] = {}
        set_clauses: list[str] = []
        remove_clauses: list[str] = []

        for index, (field, provided) in enumerate(
            (
                ("category", category),
                ("notes", notes),
                ("tags", tags),
                ("budget_excluded", budget_excluded),
            )
        ):
            if provided is _UNSET:
                continue
            if field == "category" and not provided:
                raise ValueError("category is set-only; a falsy value cannot clear it")
            name_alias = f"#f{index}"
            names[name_alias] = field
            if provided:
                value_alias = f":v{index}"
                values[value_alias] = provided
                set_clauses.append(f"{name_alias} = {value_alias}")
            else:
                remove_clauses.append(name_alias)

        # Filing by hand clears the rule stamp (WHIT-536): whenever the category is SET
        # (it is set-only — a clear is refused above), REMOVE filed_by_rule. A notes/tags/
        # budget-only edit leaves category _UNSET, so the stamp survives. REMOVE of an absent
        # stamp is a no-op.
        if category is not _UNSET:
            names["#p"] = "filed_by_rule"
            remove_clauses.append("#p")

        # No field supplied (all _UNSET) — nothing to write. Return without issuing a
        # malformed empty-expression UpdateItem.
        if not set_clauses and not remove_clauses:
            return True

        expression_parts: list[str] = []
        if set_clauses:
            expression_parts.append("SET " + ", ".join(set_clauses))
        if remove_clauses:
            expression_parts.append("REMOVE " + ", ".join(remove_clauses))

        update_kwargs: dict[str, Any] = {
            "Key": {"pk": pk, "sk": sk},
            "UpdateExpression": " ".join(expression_parts),
            "ExpressionAttributeNames": names,
            "ConditionExpression": "attribute_exists(pk)",
        }
        if values:
            update_kwargs["ExpressionAttributeValues"] = values

        try:
            self._get_table().update_item(**update_kwargs)
            return True
        except ClientError as e:
            if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return False
            handle_database_error(e, "write")

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
