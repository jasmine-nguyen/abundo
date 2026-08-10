"""Shared fakes and store builders for the category test suites.

Three suites need the same in-memory DynamoDB fake and the same store builders:
tests/lambda_api/test_categories.py (the impl suite) and its two WHIT-428 gap suites,
test_categories_whit428_gaps.py and test_categories_whit428_round2.py. They live here,
in ONE definition, so all three `import` them instead of copying the fake (which would
drift — FakeTable's 4KB UpdateExpression guard is what makes the expression-size tests
mean anything) or re-exec'ing the 4,000-line impl suite through importlib (WHIT-440).

Resolved by pytest.ini's `pythonpath = tests/shared`, the same way test_categories.py
already imports `_chart_ramp` from here — no `handler`-fixture sys.path juggling needed
to import THIS module. The `import repository` / `import repository_category` inside
_repo_with_fake_table and _schema are lazy on purpose: they run at test time, under the
`handler` fixture that puts shared/ on the path. ClientError is imported lazily inside the
three error factories for the same reason — real botocore isn't installed, and the
lambda_api conftest fakes it before any test runs.
"""

import copy
import re
from collections import Counter
from decimal import Decimal

_CFG = ("CATEGORIES", "CATEGORIES")
_SLOT = "colorSlot"

# DynamoDB's documented UpdateExpression ceiling. FakeTable enforces it so an expression that
# the real service would reject cannot pass in tests — without this, WHIT-405's chunk cap
# could be deleted and every test would still be green.
_MAX_UPDATE_EXPRESSION_BYTES = 4096


def _ccfe():
    from botocore.exceptions import ClientError
    err = ClientError()
    err.response = {"Error": {"Code": "ConditionalCheckFailedException"}}
    return err


def _validation_error(message):
    from botocore.exceptions import ClientError
    err = ClientError()
    # Message, not just Code: handle_database_error reads BOTH (shared/repository_base.py),
    # so a Message-less response raises KeyError instead of the DatabaseError under test.
    err.response = {"Error": {"Code": "ValidationException", "Message": message}}
    return err


def _throttle():
    from botocore.exceptions import ClientError
    err = ClientError()
    # handle_database_error reads Message too, so a realistic fake carries both.
    err.response = {"Error": {"Code": "ProvisionedThroughputExceededException",
                              "Message": "rate exceeded"}}
    return err


class FakeTable:
    """In-memory table emulating only the calls CategoryRepository makes:
    get_item, conditional put_item, and the nested conditional update_item."""

    def __init__(self):
        self.store = {}  # (pk, sk) -> item
        # Queue of callables(item) run just before each update_item evaluation,
        # to simulate a concurrent writer mutating the row between read and write.
        self.before_update = []
        # Every update_item call, so a test can assert a migrated store writes ZERO times.
        self.update_calls = []
        # When set, every update_item raises it — used to prove the read path fails OPEN.
        self.update_error = None

    def get_item(self, Key):
        item = self.store.get((Key["pk"], Key["sk"]))
        return {"Item": copy.deepcopy(item)} if item is not None else {}

    def put_item(self, Item, ConditionExpression=None):
        k = (Item["pk"], Item["sk"])
        if ConditionExpression == "attribute_not_exists(pk)" and k in self.store:
            raise _ccfe()
        self.store[k] = copy.deepcopy(Item)

    def update_item(self, Key, UpdateExpression, ConditionExpression,
                    ExpressionAttributeNames, ExpressionAttributeValues):
        item = self.store.get((Key["pk"], Key["sk"]))
        if self.before_update and item is not None:
            self.before_update.pop(0)(item)  # simulate a concurrent writer
        values = ExpressionAttributeValues
        self.update_calls.append(
            (UpdateExpression, dict(ExpressionAttributeNames), dict(values))
        )
        if self.update_error is not None:
            raise self.update_error
        expression_bytes = len(UpdateExpression.encode())
        if expression_bytes > _MAX_UPDATE_EXPRESSION_BYTES:
            raise _validation_error(
                f"Invalid UpdateExpression: expression is too large; "
                f"{expression_bytes} bytes exceeds the {_MAX_UPDATE_EXPRESSION_BYTES} limit"
            )

        # The colour-slot backfill is its own shape: it stamps #schema and/or one
        # #items.#catN.#slot per category. It carries no #id, so it must be handled before
        # the create/rename/delete paths read one. Route on that ABSENCE, not on a positive
        # guess at the backfill's own aliases: since WHIT-405 a partial chunk carries no
        # #schema, and a future write declaring both #id and #slot would be mis-routed here,
        # match nothing in the #cat loop, and be silently dropped while the test went green.
        if "#id" not in ExpressionAttributeNames:
            if item is None or item["version"] != values[":expected"]:
                raise _ccfe()
            # DynamoDB rejects a declared-but-unreferenced name; mirror that so a regression
            # here fails loudly in tests instead of silently passing.
            for alias in ExpressionAttributeNames:
                # Word-boundary, not substring: "#cat1" occurs inside "#cat10", so a plain
                # `in` check silently passes the very regression this guard exists for.
                assert re.search(rf"{re.escape(alias)}(?![0-9])", UpdateExpression), \
                    f"unused ExpressionAttributeName {alias}"
            for alias, real in ExpressionAttributeNames.items():
                if alias.startswith("#cat"):
                    index = alias[len("#cat"):]
                    item["items"][real]["colorSlot"] = values[f":slot{index}"]
            # A partial chunk carries no :schema — the store stays unmarked so the remaining
            # categories get picked up by a later request.
            if ":schema" in values:
                item["colorSlotSchema"] = values[":schema"]
            item["version"] = values[":next"]
            return

        cat_id = ExpressionAttributeNames["#id"]

        # attribute_exists(pk) AND #v = :expected are common to create/rename/delete.
        if item is None or item["version"] != values[":expected"]:
            raise _ccfe()

        if UpdateExpression.startswith("REMOVE"):
            # delete: guard attribute_exists(items.<id>)
            if cat_id not in item["items"]:
                raise _ccfe()
            del item["items"][cat_id]
            # Promote any children to top-level (parent -> None) — aliased #childN.
            for alias, real in ExpressionAttributeNames.items():
                if alias.startswith("#child"):
                    item["items"][real]["parent"] = values[":null"]
        elif "#items.#id.#name" in UpdateExpression:
            # update: guard attribute_exists(items.<id>); sets name, bucket, icon
            if cat_id not in item["items"]:
                raise _ccfe()
            item["items"][cat_id]["name"] = values[":name"]
            item["items"][cat_id]["bucket"] = values[":bucket"]
            item["items"][cat_id]["icon"] = values[":icon"]
            if "#items.#id.#parent" in UpdateExpression:
                item["items"][cat_id]["parent"] = values[":parent"]
        else:
            # create: guard attribute_not_exists(items.<id>)
            if cat_id in item["items"]:
                raise _ccfe()
            item["items"][cat_id] = copy.deepcopy(values[":cat"])

        item["version"] = values[":next"]


class FakeBudgetRepo:
    """Handler-level stand-in for BudgetRepository — records the cascade delete
    (WHIT-73) and serves a stored-target map so update_category's WHIT-202 Savings
    re-bucket guard can check whether a category is still budgeted. Can be armed to
    raise, to exercise the best-effort cascade path."""

    def __init__(self, raises=None, budgets=None):
        self._raises = raises
        self._budgets = budgets or {}  # {id: {"target": Decimal}}
        self.delete_calls = []
        self.clear_rollover_calls = []
        self.list_calls = 0

    def list_budgets(self):
        self.list_calls += 1
        return {k: dict(v) for k, v in self._budgets.items()}

    def delete_budget(self, cat_id):
        self.delete_calls.append(cat_id)
        if self._raises is not None:
            raise self._raises

    def clear_rollover(self, cat_id):
        # The rollover-clear cascade on a re-bucket out of spend (WHIT-474). Records the
        # call; honours the same `raises` arm so a test can exercise the best-effort swallow.
        self.clear_rollover_calls.append(cat_id)
        if self._raises is not None:
            raise self._raises


def _repo_with_fake_table(handler):
    import repository
    repo = repository.CategoryRepository()
    repo._table = FakeTable()
    return repository, repo


def _schema():
    """The CURRENT marker value, read from the module rather than written out — a settled
    store carries it, so a future bump needs no sweep through this file. A function, not a
    constant: the `handler` fixture is what puts shared/ on the path."""
    import repository_category
    return repository_category._COLOR_SLOT_SCHEMA


def _categories_event(body='{"name": "Gym", "bucket": "Lifestyle", "icon": "dumbbell"}', is_b64=False):
    return {
        "rawPath": "/categories",
        "requestContext": {"http": {"method": "POST"}},
        "body": body,
        "isBase64Encoded": is_b64,
    }


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
