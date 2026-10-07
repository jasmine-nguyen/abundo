"""The REAL JobRepository over a FakeTable for the job suites (WHIT-625).

The job rows (create, progress merge, finish) are written by production code, so a suite reads back
what the repository really stored. ``created_jobs`` and ``progress_writes`` read the table's call
recorders.

Resolved by pytest.ini's `pythonpath = tests/shared`. The shared layer is imported lazily, inside
``real_job_repo``, so inside a ``handler``-style fixture it comes from the freshly loaded copy.
"""

from _dynamo_fakes import FakeTable

_PK = "JOB"


def real_job_repo(jobs=None):
    """The REAL JobRepository over its own FakeTable. ``jobs`` maps a job id to a stored row,
    seeded straight into the table (the rows a GET reads back)."""
    from repository_job import JobRepository

    repo = JobRepository()
    repo._table = FakeTable()
    for job_id, job in (jobs or {}).items():
        repo._table.seed({"pk": _PK, "sk": f"JOB#{job_id}", **job})
    return repo


def throttled_worker(function_env_var, payload):
    """A worker launch that fails, standing in for ``_invoke_worker`` when Lambda throttles."""
    raise RuntimeError("throttled")


def created_jobs(repo):
    """(id, kind) of each job row the code created, in order."""
    return [(item["id"], item["kind"]) for item in repo._table.put_calls if item["pk"] == _PK]


def _job_updates(repo):
    """The fields each job update_item set, in order."""
    return [{name: values[":v" + alias[len("#n"):]] for alias, name in names.items()}
            for _expression, names, values in repo._table.update_calls]


def progress_writes(repo):
    """The tallies of each update_progress write, in order (finish and tool-status writes skipped)."""
    writes = []
    for fields in _job_updates(repo):
        if "status" in fields or "toolStatus" in fields:
            continue
        del fields["updated_at"]
        writes.append(fields)
    return writes


class FakeChatJobRepo:
    """For the run_chat suites (WHIT-807): the REAL JobRepository over a FakeTable (any attribute
    is the real repository's), plus what the chat worker wrote, read back from the table:
    ``statuses`` (each tool status line) and ``finished`` (each finish_chat_job write)."""

    def __init__(self):
        self._repo = real_job_repo()

    def __getattr__(self, name):
        return getattr(self._repo, name)

    @property
    def statuses(self):
        return [fields["toolStatus"] for fields in _job_updates(self._repo) if "toolStatus" in fields]

    @property
    def finished(self):
        return [{"status": fields["status"], "reply": fields["reply"], "error": fields["error"]}
                for fields in _job_updates(self._repo) if "reply" in fields]

