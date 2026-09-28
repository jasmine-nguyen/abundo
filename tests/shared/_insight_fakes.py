"""The REAL InsightRepository over a FakeTable for the AI-insight suites (WHIT-625).

The cache row is keyed by its pay-cycle start, as in production, so a seeded row is only a cache
hit for the cycle the handler actually asks for. ``insight_puts`` reads the table's put log.

Resolved by pytest.ini's `pythonpath = tests/shared`. The shared layer is imported lazily, inside
``insight_repo``, so inside a ``handler``-style fixture it comes from the freshly loaded copy.
"""

from _dynamo_fakes import FakeTable


def insight_repo(existing=None, cycle_start="2026-06-25"):
    """The real InsightRepository, holding ``existing`` (summary / suggestions / generated_at /
    input_hash) as the cached insight for ``cycle_start``. The put log is cleared after that
    setup, so ``insight_puts`` shows only the code under test."""
    from repository import InsightRepository

    repo = InsightRepository()
    repo._table = FakeTable()
    if existing is not None:
        repo.put_insight(cycle_start, **existing)
    repo._table.put_calls.clear()
    return repo


def insight_puts(repo):
    """Each insight the code stored, in order, with its ``cycle_start``."""
    return [{"cycle_start": item["sk"], "summary": item["summary"], "suggestions": item["suggestions"],
             "generated_at": item["generated_at"], "input_hash": item["input_hash"]}
            for item in repo._table.put_calls if item["pk"] == "INSIGHT"]
