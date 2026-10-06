"""Our own store for background job records (WHIT-537).

The synchronous "Apply my rules" route caps itself at 300 writes / 15s to stay inside the API
Gateway window. The async worker runs the same sweep with NO cap and writes its progress here so
the app can poll a job by id until it finishes.

Layout: one item per job under a SINGLE partition ``pk="JOB"``, ``sk="JOB#{id}"``, where ``id``
is an opaque uuid minted when the job starts. Each row carries a numeric
``expires_at`` (epoch seconds) so DynamoDB TTL removes finished jobs after ``JOB_TTL_SECONDS`` —
the same auto-expiry the dead-letter / push-receipt rows use.
"""

import logging
from datetime import datetime, timezone
from typing import Any, Optional

from constants import JOB_TTL_SECONDS
from repository_base import RepositoryBase, db_errors

logger = logging.getLogger(__name__)

# Every job row shares this partition so a future list reads them in one Query.
_PK = "JOB"

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


class JobRepository(RepositoryBase):
    """Reads and writes the background apply-rules job records in our own DynamoDB table."""

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
        with db_errors("create job"):
            self._get_table().put_item(Item=item)
        return item

    def get_job(self, job_id: str) -> Optional[dict]:
        """The job with this id, or None if there is none (an unknown/expired id)."""
        with db_errors("get job"):
            response = self._get_table().get_item(Key={"pk": _PK, "sk": _sk(job_id)})
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

    def set_tool_status(self, job_id: str, text: str) -> None:
        """The chat worker's one-line "what I'm looking at" status, shown while the app polls."""
        self._set_fields(job_id, {"toolStatus": text})

    def finish_chat_job(self, job_id: str, status: str, reply_json: Optional[str] = None,
                        error: Optional[str] = None) -> None:
        """Mark a chat job terminal. The reply is stored as JSON TEXT: it carries float
        amounts, which boto3 refuses to write as DynamoDB numbers."""
        self._set_fields(job_id, {
            "status": status, "reply": reply_json, "error": error, "completed_at": _now(),
        })

    def _set_fields(self, job_id: str, fields: dict) -> None:
        """UpdateItem SET for the given attributes plus updated_at. Every name goes through an
        alias because several (``status``, ``error``) are DynamoDB reserved words."""
        fields = {**fields, "updated_at": _now()}
        names = {f"#n{i}": name for i, name in enumerate(fields)}
        values = {f":v{i}": value for i, value in enumerate(fields.values())}
        assignments = [f"#n{i} = :v{i}" for i in range(len(fields))]
        with db_errors("update job"):
            self._get_table().update_item(
                Key={"pk": _PK, "sk": _sk(job_id)},
                UpdateExpression="SET " + ", ".join(assignments),
                ExpressionAttributeNames=names,
                ExpressionAttributeValues=values,
            )
