"""Shared fakes and store builders for the category test suites.

The category suites need the same store builders and table wiring, plus the real
BudgetRepository the category handlers cascade into (``budget_repo``). They live here, in ONE
definition, so every suite `import`s them instead of copying them or re-exec'ing the 4,000-line
impl suite through importlib (WHIT-440). The table is the shared FakeTable (_dynamo_fakes), whose
4KB UpdateExpression guard is what makes the expression-size tests mean anything (WHIT-625).

Resolved by pytest.ini's `pythonpath = tests/shared`, the same way test_categories.py
already imports `_chart_ramp` from here — no `handler`-fixture sys.path juggling needed
to import THIS module. The `import repository` / `import repository_category` inside
_repo_with_fake_table, budget_repo and _schema are lazy on purpose: they run at test time, under the
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
    from repository import BudgetRepository

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


def _schema():
    """The CURRENT marker value, read from the module rather than written out — a settled
    store carries it, so a future bump needs no sweep through this file. A function, not a
    constant: the `handler` fixture is what puts shared/ on the path."""
    import repository_category
    return repository_category._COLOR_SLOT_SCHEMA


def _categories_event(body='{"name": "Gym", "bucket": "Lifestyle", "icon": "dumbbell"}', is_b64=False):
    return api_event("POST", "/categories", raw=body, is_base64=is_b64)


def _cat(cat_id, bucket="Living", **extra):
    return {"id": cat_id, "name": cat_id.title(), "icon": "tag",
            "color": "#ffffff", "bucket": bucket, **extra}


def _drain(repo, limit=20):
    """Read until the backfill stops writing. Returns the number of write attempts."""
    for _ in range(limit):
        before = len(repo._table.update_calls)
        repo.list_categories()
        if len(repo._table.update_calls) == before:
            return before
    raise AssertionError(f"backfill did not converge within {limit} reads")


def _slot_histogram(repo):
    """Every slot 0-19 -> how many stored categories hold it, read back out of the fake table."""
    held = Counter(int(cat[_SLOT]) for cat in repo._table.store[_CFG]["items"].values()
                   if _SLOT in cat)
    return Counter({slot: held.get(slot, 0) for slot in range(20)})


def _piled_store(repo, repository, count, *, slot=0, schema=1):
    """An ALREADY-migrated store whose custom rows are all piled onto one colour — what the
    old constant-overflow backfill actually produced. Built-ins sit on their designated hues."""
    items = {cid: dict(cat) for cid, cat in repository.SEED_CATEGORIES.items()}
    for index in range(count):
        cat_id = f"cat{index:04d}"
        items[cat_id] = _cat(cat_id, colorSlot=Decimal(slot))
    item = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": items, "version": Decimal(1),
            "colorSlotSchema": Decimal(schema)}
    repo._table.store[_CFG] = item
    return item


def _random_legacy_store(repository, rng):
    """A plausible legacy store: some built-ins deleted, some already slotted (not always on
    their designated slot), plus 0-260 custom rows, some slotted, some CORRUPT. Custom ids are
    random lowercase words so the built-ins land at random positions in the alphabetical
    chunk order — the one thing the committed 'cat0000..cat0199' shape never varies.

    Lives here, in the shared fakes, so the impl suite AND the reservation-property suite draw
    the SAME store shapes from one definition (WHIT-427/429)."""
    items = {}
    for cat_id, seed in repository.SEED_CATEGORIES.items():
        roll = rng.random()
        if roll < 0.25:
            continue                                     # built-in deleted before the backfill
        row = {k: v for k, v in seed.items() if k != _SLOT}
        if roll < 0.45:
            row[_SLOT] = Decimal(rng.randrange(20))      # already slotted, maybe not its own
        items[seed["id"]] = row
    for _ in range(rng.randrange(0, 260)):
        cat_id = "".join(rng.choice("abcdefghijklmnopqrstuvwxyz") for _ in range(6))
        if cat_id in repository.SEED_CATEGORIES:
            continue
        row = {"id": cat_id, "name": cat_id, "icon": "tag", "color": "#888888",
               "bucket": "Lifestyle", "parent": None}
        roll = rng.random()
        if roll < 0.15:
            row[_SLOT] = Decimal(rng.randrange(20))
        elif roll < 0.22:
            row[_SLOT] = rng.choice(["7", 7.5, -1, 99, True])   # corrupt -> must be reassigned
        items[cat_id] = row
    return items
