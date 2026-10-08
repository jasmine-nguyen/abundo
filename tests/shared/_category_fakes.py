"""Shared fakes and store builders for the category test suites.

The category suites need the same store builders and table wiring, plus the real
BudgetRepository the category handlers cascade into (``budget_repo``). They live here, in ONE
definition, so every suite `import`s them instead of copying them or re-exec'ing the 4,000-line
impl suite through importlib (WHIT-440). The table is the shared FakeTable (_dynamo_fakes), whose
4KB UpdateExpression guard is what makes the expression-size tests mean anything (WHIT-625).

Resolved by pytest.ini's `pythonpath = tests/shared`, the same way test_categories.py
already imports `_chart_ramp` from here — no `handler`-fixture sys.path juggling needed
to import THIS module. The `import repository_budget` / `import repository_category` inside
_repo_with_fake_table and budget_repo are lazy on purpose: they run at test time, under the
`handler` fixture that puts shared/ on the path.
"""

from collections import Counter
from decimal import Decimal

from _api_event import api_event
from _dynamo_fakes import FakeTable, _client_error

_CFG = ("CATEGORIES", "CATEGORIES")
_BUDGETS = ("BUDGETS", "BUDGETS")
_SLOT = "colorSlot"


def _ccfe():
    return _client_error("ConditionalCheckFailedException")


def _before_next_update(table, mutate):
    """Queue ``mutate(item)`` to run on the stored config item just before the next write — a
    concurrent writer landing between the repository's read and its conditional write."""
    def run(key, tbl):
        item = tbl.store.get((key["pk"], key["sk"]))
        if item is not None:
            mutate(item)
    table.before_next_write(run)


def budget_repo(budgets=None):
    """The REAL BudgetRepository over its own FakeTable holding ``budgets`` ({id: entry}), so the
    delete cascade and the rollover/spread clears run as production wrote them (WHIT-625)."""
    from repository_budget import BudgetRepository

    repo = BudgetRepository()
    repo._table = FakeTable()
    repo._table.seed({"pk": "BUDGETS", "sk": "BUDGETS", "items": budgets or {}, "version": Decimal(1)})
    return repo


def stored_budgets(repo):
    """The budget entries the table holds now ({id: entry})."""
    return repo._table.store[_BUDGETS]["items"]


def _repo_with_fake_table(handler):
    import repository_category
    repo = repository_category.CategoryRepository()
    repo._table = FakeTable()
    return repository_category, repo


def _categories_event(body='{"name": "Gym", "bucket": "Lifestyle", "icon": "dumbbell"}', is_b64=False):
    return api_event("POST", "/categories", raw=body, is_base64=is_b64)


def _cat(cat_id, bucket="Living", **extra):
    return {"id": cat_id, "name": cat_id.title(), "icon": "tag",
            "color": "#ffffff", "bucket": bucket, **extra}


def _slot_histogram(repo):
    """Every slot 0-19 -> how many stored categories hold it, read back out of the fake table."""
    held = Counter(int(cat[_SLOT]) for cat in repo._table.store[_CFG]["items"].values()
                   if _SLOT in cat)
    return Counter({slot: held.get(slot, 0) for slot in range(20)})
