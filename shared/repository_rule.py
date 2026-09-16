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
from repository_errors import (
    RuleClashError,
    RuleNotFoundError,
    DatabaseError,
)
import rule_engine

logger = logging.getLogger(__name__)

# Every rule row shares this partition so list_rules reads them in one Query rather than a
# Scan. It is also the value the IAM DeleteItem grant pins via dynamodb:LeadingKeys, so the
# API can only ever delete rule rows — see delete_rule and terraform/iam.tf.
_PK = "RULE"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def rule_identity(field: str, operator: str, value: str,
                   conditions: Optional[list], logic: Optional[str]) -> str:
    """The rule's id — its canonical multi-condition hash when it carries `conditions` (WHIT-541),
    else the legacy single-condition hash. A 1-condition rule collapses to the legacy id inside
    rule_id_for_conditions, so an existing rule keeps its id."""
    if conditions:
        return rule_engine.rule_id_for_conditions(conditions, logic)
    return rule_engine.rule_id_for(field, operator, value)


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
        budget_excluded: bool = False,
        conditions: Optional[list] = None,
        logic: Optional[str] = None,
        spread: bool = False,
        spread_amount: Optional[Any] = None,
        spread_gap_days: Optional[int] = None,
    ) -> tuple[dict, bool]:
        """Create a rule, returning ``(rule, created)``.

        The id is derived from the text, so re-creating the SAME text is idempotent:
          - same text + same category + same budget_excluded + same spread flag -> the existing row,
            ``created=False``.
          - same text but a DIFFERENT category, a different budget_excluded, OR a different spread flag
            -> ``RuleClashError`` (the two would fight over the same charges — over the category, over
            whether the charge is kept out of the budget, or over whether it is auto-spread — and a
            conflicted charge is never filed).
        The ``attribute_not_exists(pk)`` condition is the dedup guard — dropping it would let the
        second create silently overwrite the first. ``budget_excluded`` and ``spread`` are deliberately
        NOT part of the id (the id stays the rule TEXT, rule_engine.rule_id_for), so they can only ever
        collide, never mint a second row for the same text.
        """
        rule_id = rule_identity(field, operator, value, conditions, logic)
        item = _rule_row(rule_id, field, operator, value, category_id,
                         budget_excluded=budget_excluded, conditions=conditions, logic=logic,
                         spread=spread, spread_amount=spread_amount, spread_gap_days=spread_gap_days,
                         created_at=_now())
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
            if (existing.get("category_id") != category_id
                    or bool(existing.get("budget_excluded")) != budget_excluded
                    or bool(existing.get("spread")) != spread):
                raise RuleClashError(existing)
            return existing, False

    def update_rule(
        self,
        rule_id: str,
        field: str,
        operator: str,
        value: str,
        category_id: str,
        budget_excluded: bool = False,
        conditions: Optional[list] = None,
        logic: Optional[str] = None,
        spread: bool = False,
        spread_amount: Optional[Any] = None,
        spread_gap_days: Optional[int] = None,
    ) -> dict:
        """Edit a rule, returning the updated rule.

        Editing the text changes the id (the id IS the text), so this is not always an in-place
        update:
          - id unchanged (a category change, a budget_excluded/spread toggle, or a case-/spacing-only
            value edit) -> update in place.
          - id changed onto ANOTHER existing rule's text -> ``RuleClashError`` (merging two rules
            into one on an edit is ambiguous; refuse it).
          - id changed onto free text -> write the new row (carrying the old row's created_at), then
            delete the old row.
        Unknown id -> ``RuleNotFoundError``.
        """
        existing = self.get_rule(rule_id)
        if existing is None:
            raise RuleNotFoundError(rule_id)

        new_id = rule_identity(field, operator, value, conditions, logic)
        now = _now()

        if new_id == rule_id:
            self._update_in_place(rule_id, value, category_id, budget_excluded, now,
                                  conditions=conditions, logic=logic, spread=spread,
                                  spread_amount=spread_amount, spread_gap_days=spread_gap_days,
                                  was_spread=bool(existing.get("spread")))
            updated = {**existing, "value": value, "category_id": category_id,
                       "budget_excluded": budget_excluded, "spread": spread, "updated_at": now}
            if conditions:
                updated["conditions"] = conditions
                updated["logic"] = logic or "all"
            # Reflect the captured-bill fields the in-place write applied (see _update_in_place):
            # a spread rule carries them; a rule edited out of spreading sheds them.
            if spread:
                updated["spread_amount"] = spread_amount
                updated["spread_gap_days"] = spread_gap_days
                if not existing.get("spread"):
                    updated["spread_seeded"] = False
            else:
                for stale in ("spread_amount", "spread_gap_days", "spread_seeded"):
                    updated.pop(stale, None)
            return updated

        clash = self.get_rule(new_id)
        if clash is not None:
            raise RuleClashError(clash)

        new_row = _rule_row(
            new_id, field, operator, value, category_id, budget_excluded=budget_excluded,
            conditions=conditions, logic=logic, spread=spread, spread_amount=spread_amount,
            spread_gap_days=spread_gap_days,
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
                         budget_excluded: bool, now: str,
                         conditions: Optional[list] = None, logic: Optional[str] = None,
                         spread: bool = False, spread_amount: Optional[Any] = None,
                         spread_gap_days: Optional[int] = None, was_spread: bool = False) -> None:
        # `value` is a DynamoDB reserved word, so every name goes through an alias. Only aliases the
        # expression actually references are declared (DynamoDB rejects an unused ExpressionAttributeName).
        names = {"#v": "value", "#c": "category_id", "#b": "budget_excluded", "#u": "updated_at",
                 "#sm": "spread"}
        values = {":v": value, ":c": category_id, ":b": budget_excluded, ":u": now, ":sm": spread}
        assignments = ["#v = :v", "#c = :c", "#b = :b", "#u = :u", "#sm = :sm"]
        removals: list[str] = []
        # A same-id edit keeps the rule's identity, but the shape can change: a multi-condition rule
        # re-writes its conditions (a case-/spacing-only value edit may have changed the RAW values),
        # while a rule edited down to a single flat condition must have any stale conditions/logic
        # REMOVEd — otherwise the stored shape lies to decide's multi-rule guard. (REMOVE of an
        # absent attribute is a no-op, so a plain single-rule edit is unaffected.)
        names["#cd"], names["#lg"] = "conditions", "logic"
        if conditions:
            values[":cd"], values[":lg"] = conditions, (logic or "all")
            assignments += ["#cd = :cd", "#lg = :lg"]
        else:
            removals += ["#cd", "#lg"]
        # The captured-bill fields track the spread flag (WHIT-559): a spread rule carries the amount
        # + gap; a rule edited OUT of spreading sheds them. spread_seeded ("has this rule created its
        # plan yet") is (re)armed to False only when spreading is turned ON fresh — when the rule was
        # already spread, it is left untouched so a user who dismissed an auto-spread plan is not
        # re-seeded by an unrelated edit ("stay dismissed", WHIT-559).
        if spread:
            names["#sa"], names["#sg"] = "spread_amount", "spread_gap_days"
            values[":sa"], values[":sg"] = spread_amount, spread_gap_days
            assignments += ["#sa = :sa", "#sg = :sg"]
            if not was_spread:
                names["#ss"] = "spread_seeded"
                values[":ss"] = False
                assignments.append("#ss = :ss")
        else:
            names["#sa"], names["#sg"], names["#ss"] = "spread_amount", "spread_gap_days", "spread_seeded"
            removals += ["#sa", "#sg", "#ss"]
        update_expression = "SET " + ", ".join(assignments)
        if removals:
            update_expression += " REMOVE " + ", ".join(removals)
        try:
            self._get_table().update_item(
                Key={"pk": _PK, "sk": f"RULE#{rule_id}"},
                UpdateExpression=update_expression,
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
        """Delete a rule. Safe to run twice — deleting a missing key is a no-op, so the app's
        delete stays idempotent.
        """
        # The pk is the literal "RULE" — the SAME value the IAM DeleteItem grant pins via
        # dynamodb:LeadingKeys (terraform/iam.tf). Kept a literal at the call site (not _PK, not a
        # variable) so the IAM guard test can read that the API only ever deletes rule rows.
        try:
            self._get_table().delete_item(Key={"pk": "RULE", "sk": f"RULE#{rule_id}"})
        except ClientError as e:
            handle_database_error(e, "delete rule")

    def mark_spread_seeded(self, rule_id: str) -> None:
        """Flip a spread rule's ``spread_seeded`` marker to True — called once, after the rule has
        auto-created its category's spread plan (WHIT-559), so it never seeds again even if the user
        deletes the plan ("stay dismissed"). Idempotent: re-setting True is a no-op. A rule deleted
        mid-flight is a no-op success — the ``attribute_exists(pk)`` guard fails, and a plan that no
        rule points at simply won't be re-seeded, which is the intended end state.
        """
        try:
            self._get_table().update_item(
                Key={"pk": _PK, "sk": f"RULE#{rule_id}"},
                UpdateExpression="SET #ss = :true",
                ConditionExpression="attribute_exists(pk)",
                ExpressionAttributeNames={"#ss": "spread_seeded"},
                ExpressionAttributeValues={":true": True},
            )
        except ClientError as e:
            if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return  # the rule was deleted between filing and this write — nothing to mark
            handle_database_error(e, "mark rule spread")


def _rule_row(rule_id: str, field: str, operator: str, value: str, category_id: str,
              *, budget_excluded: bool = False, conditions: Optional[list] = None,
              logic: Optional[str] = None, spread: bool = False,
              spread_amount: Optional[Any] = None, spread_gap_days: Optional[int] = None,
              created_at: str, updated_at: Optional[str] = None) -> dict:
    """Build a rule item. Every rule is app-authored, so ``source`` is always "app".

    ``budget_excluded`` is stored ALWAYS as a bool (not sparse): a rule row is never budget-summed,
    so the transaction sparse-false convention doesn't apply, and an always-present flag keeps the
    in-place update and the clash compare uniform. An old row written before this field reads back
    ``.get("budget_excluded", False)``.

    ``spread`` (WHIT-559) is the second action flag, stored ALWAYS as a bool like ``budget_excluded``.
    A spread rule also carries the recurring bill it captured at create time — ``spread_amount``
    (Decimal cents) and ``spread_gap_days`` (the median day-gap the cadence→cycles conversion uses at
    apply) — plus ``spread_seeded`` (has this rule created its category's spread plan yet), seeded
    False. Those three are SPARSE: present only on a spread rule, so a non-spread row gains just the
    one ``spread: False`` flag. An old row reads back ``.get("spread", False)``.

    A multi-condition rule (WHIT-541) adds ``conditions`` + ``logic``; the flat field/operator/value
    are still written (set by the caller to the first condition) so a legacy reader has a shape, but
    the engine reads ``conditions`` when present. A single-condition rule stores neither, so old rows
    and simple rules are byte-identical to before.
    """
    row = {
        "pk": _PK, "sk": f"RULE#{rule_id}", "id": rule_id,
        "field": field, "operator": operator, "value": value,
        "category_id": category_id, "budget_excluded": budget_excluded, "spread": spread,
        "source": "app", "created_at": created_at, "updated_at": updated_at or created_at,
    }
    if conditions:
        row["conditions"] = conditions
        row["logic"] = logic or "all"
    if spread:
        row["spread_amount"] = spread_amount
        row["spread_gap_days"] = spread_gap_days
        row["spread_seeded"] = False
    return row
