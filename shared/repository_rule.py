"""Our own store for categorisation rules (WHIT-528) — rules move off BankSync so there is
no 100-rule cap.

Layout: one item per rule under a SINGLE partition ``pk="RULE"``, ``sk="RULE#{id}"``, where
``id`` is ``rule_engine.rule_id_for(field, operator, value)`` — the first 16 hex of
sha256("field|operator|folded value"). The database key therefore IS the duplicate guard:
the same rule text always lands on the same row, so a conditional ``attribute_not_exists``
put is all the dedup we need. The shared partition lets ``list_rules`` read every rule in one
Query (paged) instead of scanning the table.

Kept as a flat top-level module (not a ``repository/`` package) and constants-free on purpose:
the shared layer is staged with a non-recursive ``cp shared/*.py`` (terraform/layers.tf), which
would silently drop a package directory; and ``lambda_api/constants.py`` shadows the shared
constants at runtime, so importing a shared ``constants`` name here would 500 the deployed API
(AGENTS.md). The one tunable — the page cap — is defined LOCALLY below.
"""

import logging
from datetime import datetime, timezone
from typing import Any, Optional

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from repository_base import REGION_NAME, TABLE_NAME, handle_database_error
from repository_errors import RuleClashError, RuleNotFoundError, DatabaseError
import rule_engine

logger = logging.getLogger(__name__)

# Every rule row shares this partition so list_rules reads them in one Query rather than a
# Scan. It is also the value the IAM DeleteItem grant pins via dynamodb:LeadingKeys, so the
# API can only ever delete rule rows — see delete_rule and terraform/iam.tf.
_PK = "RULE"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class RuleRepository:
    """Reads and writes the user's categorisation rules in our own DynamoDB table."""

    def __init__(self) -> None:
        self._dynamodb = None
        self._table = None

    def _get_table(self) -> Any:
        if self._table is None:
            self._dynamodb = boto3.resource("dynamodb", region_name=REGION_NAME)
            self._table = self._dynamodb.Table(TABLE_NAME)
        return self._table

    def list_rules(self) -> list[dict]:
        """Every rule, read from the shared partition. Pages via ``LastEvaluatedKey`` so a
        set larger than one 1 MB page is still read whole — this is what removes the 100 cap.
        (Single-user volume realistically fits one page, but the loop matches the sibling repos
        and is what makes "unlimited rules" true rather than aspirational.)"""
        rules: list[dict] = []
        query_kwargs: dict[str, Any] = {"KeyConditionExpression": Key("pk").eq(_PK)}
        try:
            while True:
                response = self._get_table().query(**query_kwargs)
                rules.extend(response.get("Items", []))
                cursor = response.get("LastEvaluatedKey")
                if not cursor:
                    return rules
                query_kwargs["ExclusiveStartKey"] = cursor
        except ClientError as e:
            handle_database_error(e, "list rules")

    def get_rule(self, rule_id: str) -> Optional[dict]:
        """The rule with this id, or None if there is none."""
        try:
            response = self._get_table().get_item(Key={"pk": _PK, "sk": f"RULE#{rule_id}"})
        except ClientError as e:
            handle_database_error(e, "get rule")
        return response.get("Item")

    def create_rule(
        self,
        field: str,
        operator: str,
        value: str,
        category_id: str,
        *,
        source: str = "app",
        imported_at: Optional[str] = None,
        banksync_enrichment_ids: Optional[list] = None,
    ) -> tuple[dict, bool]:
        """Create a rule, returning ``(rule, created)``.

        The id is derived from the text, so re-creating the SAME text is idempotent:
          - same text + same category -> the existing row, ``created=False``.
          - same text + DIFFERENT category -> ``RuleClashError`` (the two would fight over the
            same charges, and a conflicted charge is never filed).
        The ``attribute_not_exists(pk)`` condition is the dedup guard — dropping it would let the
        second create silently overwrite the first.
        """
        rule_id = rule_engine.rule_id_for(field, operator, value)
        item = _rule_row(rule_id, field, operator, value, category_id, source,
                         imported_at, banksync_enrichment_ids, created_at=_now())
        try:
            self._get_table().put_item(Item=item, ConditionExpression="attribute_not_exists(pk)")
            return item, True
        except ClientError as e:
            if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
                handle_database_error(e, "create rule")
            existing = self.get_rule(rule_id)
            if existing is None:
                # The row vanished between the refused put and the read — a genuine race,
                # not a clash. Surface it as a DB fault rather than inventing a clash.
                handle_database_error(e, "create rule")
            if existing.get("category_id") != category_id:
                raise RuleClashError(existing)
            return existing, False

    def update_rule(
        self,
        rule_id: str,
        field: str,
        operator: str,
        value: str,
        category_id: str,
        *,
        source: Optional[str] = None,
    ) -> dict:
        """Edit a rule, returning the updated rule.

        Editing the text changes the id (the id IS the text), so this is not always an in-place
        update:
          - id unchanged (a category change, or a case-/spacing-only value edit) -> update in place.
          - id changed onto ANOTHER existing rule's text -> ``RuleClashError`` (merging two rules
            into one on an edit is ambiguous; refuse it).
          - id changed onto free text -> write the new row (carrying the old row's created_at and
            banksync_enrichment_ids), then delete the old row.
        Unknown id -> ``RuleNotFoundError``.
        """
        existing = self.get_rule(rule_id)
        if existing is None:
            raise RuleNotFoundError(rule_id)

        new_id = rule_engine.rule_id_for(field, operator, value)
        now = _now()

        if new_id == rule_id:
            self._update_in_place(rule_id, value, category_id, source, now)
            updated = {**existing, "value": value, "category_id": category_id, "updated_at": now}
            if source is not None:
                updated["source"] = source
            return updated

        clash = self.get_rule(new_id)
        if clash is not None:
            raise RuleClashError(clash)

        new_row = _rule_row(
            new_id, field, operator, value, category_id,
            source if source is not None else existing.get("source", "app"),
            existing.get("imported_at"), existing.get("banksync_enrichment_ids"),
            created_at=existing.get("created_at", now), updated_at=now,
        )
        try:
            self._get_table().put_item(Item=new_row, ConditionExpression="attribute_not_exists(pk)")
        except ClientError as e:
            if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                # Someone created new_id between the pre-check and here. Read it back to report
                # the clash; if it vanished again it's a race, not a clash — same as create_rule.
                raced = self.get_rule(new_id)
                if raced is None:
                    handle_database_error(e, "update rule")
                raise RuleClashError(raced)
            handle_database_error(e, "update rule")

        # New row is safely written; now retire the old one. If the delete fails we keep the new
        # rule and log loudly with BOTH ids — re-issuing the same edit is safe-to-run-twice (the
        # put hits the same sk and no-ops, the delete is retried), so the orphan self-heals.
        try:
            self.delete_rule(rule_id)
        except DatabaseError:
            logger.warning(
                "update_rule: wrote new rule %s but failed to delete old rule %s; both rows "
                "exist until the edit is retried", new_id, rule_id)
        return new_row

    def _update_in_place(self, rule_id: str, value: str, category_id: str,
                         source: Optional[str], now: str) -> None:
        # `value` and `source` are DynamoDB reserved words, so every name goes through an alias.
        names = {"#v": "value", "#c": "category_id", "#u": "updated_at"}
        values = {":v": value, ":c": category_id, ":u": now}
        assignments = ["#v = :v", "#c = :c", "#u = :u"]
        if source is not None:
            names["#s"] = "source"
            values[":s"] = source
            assignments.append("#s = :s")
        try:
            self._get_table().update_item(
                Key={"pk": _PK, "sk": f"RULE#{rule_id}"},
                UpdateExpression="SET " + ", ".join(assignments),
                ExpressionAttributeNames=names,
                ExpressionAttributeValues=values,
                ConditionExpression="attribute_exists(pk)",
            )
        except ClientError as e:
            if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                # Read then write are not atomic — the row was deleted in the gap.
                raise RuleNotFoundError(rule_id)
            handle_database_error(e, "update rule")

    def delete_rule(self, rule_id: str) -> None:
        """Delete a rule. Safe to run twice — deleting a missing key is a no-op."""
        try:
            # The pk is the literal "RULE" — the SAME value the IAM DeleteItem grant pins via
            # dynamodb:LeadingKeys (terraform/iam.tf). Kept a literal here (not _PK) so the IAM
            # guard test can prove, at this call, that the API only ever deletes rule rows.
            self._get_table().delete_item(Key={"pk": "RULE", "sk": f"RULE#{rule_id}"})
        except ClientError as e:
            handle_database_error(e, "delete rule")


def _rule_row(rule_id: str, field: str, operator: str, value: str, category_id: str,
              source: str, imported_at: Optional[str], banksync_enrichment_ids: Optional[list],
              *, created_at: str, updated_at: Optional[str] = None) -> dict:
    """Build a rule item. Optional fields are OMITTED when empty (rows stay sparse, matching
    sanitise_transaction) so an app-authored rule carries no import metadata."""
    row = {
        "pk": _PK, "sk": f"RULE#{rule_id}", "id": rule_id,
        "field": field, "operator": operator, "value": value,
        "category_id": category_id, "source": source,
        "created_at": created_at, "updated_at": updated_at or created_at,
    }
    if imported_at:
        row["imported_at"] = imported_at
    if banksync_enrichment_ids:
        row["banksync_enrichment_ids"] = list(banksync_enrichment_ids)
    return row
