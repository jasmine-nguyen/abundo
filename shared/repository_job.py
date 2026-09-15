"""Our own store for background job records (WHIT-537).

The synchronous "Apply my rules" route caps itself at 300 writes / 15s to stay inside the API
Gateway window. The async worker runs the same sweep with NO cap and writes its progress here so
the app can poll a job by id until it finishes.

Layout: one item per job under a SINGLE partition ``pk="JOB"``, ``sk="JOB#{id}"``, where ``id``
is an opaque uuid minted when the job starts. The shared partition lets a future "list my jobs"
read every job in one Query (the RULE store's rationale). Each row carries a numeric
``expires_at`` (epoch seconds) so DynamoDB TTL removes finished jobs after ``JOB_TTL_SECONDS`` —
the same auto-expiry the dead-letter / push-receipt rows use.

Kept as a flat top-level module (not a ``repository/`` package) and constants-free on purpose:
the shared layer is staged with a non-recursive ``cp shared/*.py`` (terraform/layers.tf), which
would silently drop a package directory; and ``lambda_api/constants.py`` shadows the shared
constants at runtime, so importing a shared ``constants`` name here would 500 the deployed API
(AGENTS.md). The one tunable — the TTL — is defined LOCALLY below.
"""

import logging
from datetime import datetime, timezone
from typing import Any, Optional

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from repository_base import REGION_NAME, TABLE_NAME, handle_database_error

logger = logging.getLogger(__name__)

# Every job row shares this partition so a future list reads them in one Query.
_PK = "JOB"

# A finished job is only useful while the app is still polling it, so it self-deletes a day
# later via DynamoDB TTL (epoch-seconds `expires_at`, same mechanism as the dead-letter rows).
JOB_TTL_SECONDS = 24 * 60 * 60

# The running tallies a job carries. update_progress accepts any subset of these; anything else
# in the passed dict is ignored, so an outcome-list key can't accidentally land a list in a
# numeric column.
_COUNT_FIELDS = ("matched", "attempted", "filed", "vanished", "failed", "alreadyFiled", "remaining")

# Terminal states the worker sets via finish_job; "running" is the only non-terminal state.
STATUS_RUNNING = "running"
STATUS_SUCCEEDED = "succeeded"
STATUS_FAILED = "failed"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sk(job_id: str) -> str:
    return f"JOB#{job_id}"


class JobRepository:
    """Reads and writes the background apply-rules job records in our own DynamoDB table."""

    def __init__(self) -> None:
        self._dynamodb = None
        self._table = None

    def _get_table(self) -> Any:
        if self._table is None:
            self._dynamodb = boto3.resource("dynamodb", region_name=REGION_NAME)
            self._table = self._dynamodb.Table(TABLE_NAME)
        return self._table

    def create_job(self, job_id: str, kind: str = "apply_rules") -> dict:
        """Create a fresh job row in the ``running`` state with zeroed tallies. Called once, from
        the POST that starts the job, BEFORE the worker is invoked, so the first poll always finds
        a record."""
        now = _now()
        item = {
            "pk": _PK, "sk": _sk(job_id), "id": job_id, "kind": kind,
            "status": STATUS_RUNNING,
            **{field: 0 for field in _COUNT_FIELDS},
            "createdRule": None, "error": None,
            "created_at": now, "updated_at": now, "completed_at": None,
            # Epoch-seconds TTL (NOT the isoformat timestamps above) — DynamoDB only expires a
            # numeric attribute, so an isoformat here would leave the row forever (WHIT-54 pattern).
            "expires_at": int(datetime.now(timezone.utc).timestamp()) + JOB_TTL_SECONDS,
        }
        try:
            self._get_table().put_item(Item=item)
        except ClientError as e:
            handle_database_error(e, "create job")
        return item

    def get_job(self, job_id: str) -> Optional[dict]:
        """The job with this id, or None if there is none (an unknown/expired id)."""
        try:
            response = self._get_table().get_item(Key={"pk": _PK, "sk": _sk(job_id)})
        except ClientError as e:
            handle_database_error(e, "get job")
        return response.get("Item")

    def update_progress(self, job_id: str, counts: dict) -> None:
        """Merge the running tallies (any subset of ``_COUNT_FIELDS``) into the job row and bump
        ``updated_at``. The worker calls this periodically so a poll sees the bar move; it never
        changes ``status`` (only finish_job does)."""
        self._set_fields(job_id, {field: counts[field] for field in _COUNT_FIELDS if field in counts})

    def finish_job(self, job_id: str, status: str, counts: dict,
                   created_rule: Optional[dict] = None, error: Optional[str] = None) -> None:
        """Mark the job terminal (``succeeded`` or ``failed``), write the final tallies, the minted
        rule (or None), any error string, and ``completed_at``. Safe to call after a partial run —
        the counts are whatever was reached."""
        fields: dict[str, Any] = {field: counts[field] for field in _COUNT_FIELDS if field in counts}
        fields["status"] = status
        fields["createdRule"] = created_rule
        fields["error"] = error
        fields["completed_at"] = _now()
        self._set_fields(job_id, fields)

    def _set_fields(self, job_id: str, fields: dict) -> None:
        """UpdateItem SET for the given attributes plus updated_at. Every name goes through an
        alias because several (``status``, ``error``) are DynamoDB reserved words."""
        fields = {**fields, "updated_at": _now()}
        names = {f"#n{i}": name for i, name in enumerate(fields)}
        values = {f":v{i}": value for i, value in enumerate(fields.values())}
        assignments = [f"#n{i} = :v{i}" for i in range(len(fields))]
        try:
            self._get_table().update_item(
                Key={"pk": _PK, "sk": _sk(job_id)},
                UpdateExpression="SET " + ", ".join(assignments),
                ExpressionAttributeNames=names,
                ExpressionAttributeValues=values,
            )
        except ClientError as e:
            handle_database_error(e, "update job")

    def list_jobs(self) -> list[dict]:
        """Every job row, from the shared partition (paged). Not used by the server slice's own
        routes yet — provided so the read path matches the sibling repos and a future "recent
        jobs" view is one Query, not a Scan."""
        jobs: list[dict] = []
        query_kwargs: dict[str, Any] = {"KeyConditionExpression": Key("pk").eq(_PK)}
        try:
            while True:
                response = self._get_table().query(**query_kwargs)
                jobs.extend(response.get("Items", []))
                cursor = response.get("LastEvaluatedKey")
                if not cursor:
                    return jobs
                query_kwargs["ExclusiveStartKey"] = cursor
        except ClientError as e:
            handle_database_error(e, "list jobs")
