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


def progress_writes(repo):
    """The tallies of each update_progress write, in order (finish and tool-status writes skipped)."""
    writes = []
    for _expression, names, values in repo._table.update_calls:
        fields = {name: values[":v" + alias[len("#n"):]] for alias, name in names.items()}
        if "status" in fields or "toolStatus" in fields:
            continue
        del fields["updated_at"]
        writes.append(fields)
    return writes
