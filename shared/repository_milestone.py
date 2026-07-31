"""Milestone storage: the user's mortgage-milestone plan (a list of balance targets
no bank feed provides), kept as a single DynamoDB config item.

Mirrors LoanFactsRepository (single item, whole-object PUT overwrite, None when
unset) — a milestone plan is one settings object with a single writer, so a plain
put_item is enough (no version guard). Deliberately NOT seeded: get returns None
until the user saves, and the app falls back to its own built-in default plan.

WHIT-375 multi-tenant seam: the DynamoDB key is derived through _milestones_key(scope)
rather than a fixed constant. Today every caller passes the shared scope, so the plan
lands at one fixed key exactly like the other single-box config repos. Multi-user later
passes an authenticated user id as `scope` — only this helper and the handler's
current_scope() change; the stored list shape carries no owner field.
"""

from decimal import Decimal
from typing import Any, Optional

import boto3
from botocore.exceptions import ClientError

from repository_base import REGION_NAME, TABLE_NAME, handle_database_error, logger

# The single tenant every request maps to until multi-user lands. A module literal,
# not a shared constant, so it never crosses the lambda_api constants shadow (WHIT-136).
_MILESTONE_SCOPE_SHARED = "SHARED"


def _milestones_key(scope: str) -> dict:
    # Multi-tenant seam (WHIT-375): the plan's OWNER lives in the sort key. `scope` is the
    # shared constant today, an authenticated user id later — the only line that changes
    # for per-user milestones.
    return {"pk": "MILESTONES", "sk": scope}


def _to_client(milestones: list) -> list:
    """Normalise stored milestones to the client shape: only {id, label, targetBalance,
    targetDate}, with targetBalance as a float (stored as Decimal). pk/sk stay internal.

    Skips any milestone missing a field or with a non-numeric targetBalance, so a legacy or
    partially-written row degrades to a shorter list instead of 500ing the client read
    (WHIT-383). The poller reads through get_milestones_raw, which does NOT use this and
    stays deliberately fail-loud on a bad row (shared/milestones.py)."""
    # A corrupt row could store `milestones` as a non-list (a scalar isn't iterable); guard
    # the iteration itself so the client read degrades to empty instead of 500ing (WHIT-383).
    if not isinstance(milestones, list):
        logger.warning("stored milestones is not a list, ignoring: %r", milestones)
        return []
    client_milestones = []
    for m in milestones:
        try:
            client_milestones.append(
                {
                    "id": m["id"],
                    "label": m["label"],
                    "targetBalance": float(m["targetBalance"]),
                    "targetDate": m["targetDate"],
                }
            )
        except (KeyError, TypeError, ValueError):
            # Degrade, don't 500 — but leave a breadcrumb so a legacy/partial row that
            # silently drops from a user's plan is diagnosable.
            logger.warning("skipping malformed stored milestone on client read: %r", m)
            continue
    return client_milestones


class MilestoneRepository:
    """Stores the user's mortgage-milestone plan as a single config item at
    pk="MILESTONES", sk=<scope>. `get_milestones` returns the list (or None if the
    user hasn't saved one yet); `set_milestones` overwrites the whole list."""

    def __init__(self) -> None:
        self._dynamodb = None
        self._table = None

    def _get_table(self) -> Any:
        if self._table is None:
            self._dynamodb = boto3.resource("dynamodb", region_name=REGION_NAME)
            self._table = self._dynamodb.Table(TABLE_NAME)
        return self._table

    def _read_milestones(self, scope: str) -> Optional[list]:
        """The shared read: the raw stored milestone list (targetBalance as Decimal), or None
        when unset. One place for the get_item + error handling so the two public accessors
        below can't drift (the WHIT-88 duplicated-read-path landmine)."""
        try:
            item = self._get_table().get_item(Key=_milestones_key(scope)).get("Item")
        except ClientError as e:
            handle_database_error(e, "read milestones")
        # .get so a row that exists without a "milestones" attribute (a legacy or partial
        # write) reads as unset (None) rather than KeyError-500ing — both accessors below
        # already treat None as "no plan saved" (WHIT-383).
        return None if item is None else item.get("milestones")

    def get_milestones(self, scope: str = _MILESTONE_SCOPE_SHARED) -> Optional[list]:
        """Return the stored milestone list, or None if the user hasn't saved one.

        Each milestone is {id, label, targetBalance, targetDate}; targetBalance is
        normalised to float so the handler serialises it as a JSON number.
        """
        raw = self._read_milestones(scope)
        return None if raw is None else _to_client(raw)

    def get_milestones_raw(self, scope: str = _MILESTONE_SCOPE_SHARED) -> Optional[list]:
        """Return the stored milestone list with targetBalance as the raw Decimal (not
        floated like get_milestones), or None if unset. The balance poller compares each
        target against the Decimal balance exact-to-the-cent, so it must skip _to_client's
        float() cast, which would fuzz a custom cent boundary (WHIT-384)."""
        return self._read_milestones(scope)

    def set_milestones(self, milestones: list, scope: str = _MILESTONE_SCOPE_SHARED) -> list:
        """Overwrite the whole milestone list and return it (normalised to floats).

        The handler passes each milestone with targetBalance already a Decimal. The whole
        item is replaced on every save (single writer), so a plain put_item is enough.
        """
        item = {**_milestones_key(scope), "milestones": milestones}
        try:
            self._get_table().put_item(Item=item)
        except ClientError as e:
            handle_database_error(e, "set milestones")
        return _to_client(milestones)
