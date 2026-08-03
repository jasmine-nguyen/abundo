"""WHIT-428 GAP tests — the schema-1 -> schema-2 colour REPAINT, adversarially.

test_categories.py already pins the outcomes (spread, level, minimum churn, chunk
equivalence, marker invariant, create-never-repainted). These are the axes it leaves open,
all reached THROUGH the repaint stage rather than the backfill stage:

  * the fail-open / fail-closed policy through a REPAINT chunk — a second, distinct
    _write_color_slots call site (`settled=True`, a plan of movers). The impl suite only
    drives those branches through the BACKFILL, and the strict non-ClientError branch
    (`except Exception: if strict: raise`) has no test at all;
  * the marker's `>=` comparison — a store already stamped BEYOND schema 2;
  * the repaint's own chunk boundary (exactly _COLOR_SLOT_WRITE_CHUNK movers, and one more),
    and the documented 129-fits / 130-rejected 4KB clause arithmetic the repaint now inherits;
  * `_with_slots` purity — the settled probe must never leak a previewed colour into the
    caller's rows, and a read mid-BACKFILL must still show STORED colours;
  * `least_held_color_slot`'s new `protected` tier: ignored while any slot is un-owed, and
    its defensive all-protected fallback;
  * hostile stored ids (DynamoDB reserved word, a dot, unicode + spaces) through a repaint
    write, and corrupt stored slots mixed with a pile;
  * a version race landing between a repaint chunk's read and its write;
  * handler level (GET/POST /categories) mid-repaint — criterion 6, "no new way to 500".

The impl suite owns the fakes (FakeTable, _piled_store, _drain, ...). They are LOADED from
it by path rather than re-implemented: a re-implemented FakeTable would drift and start
passing tests the real one rejects (its 4KB guard is what makes [A8] mean anything).
"""

import copy
import importlib.util
import inspect
import json
import pathlib
from collections import Counter
from decimal import Decimal

import pytest

_SPEC = importlib.util.spec_from_file_location(
    "_whit428_impl_suite", pathlib.Path(__file__).with_name("test_categories.py"))
_IMPL = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_IMPL)

_CFG = _IMPL._CFG
_SLOT = _IMPL._SLOT
_MAX_UPDATE_EXPRESSION_BYTES = _IMPL._MAX_UPDATE_EXPRESSION_BYTES
_cat = _IMPL._cat
_categories_event = _IMPL._categories_event
_drain = _IMPL._drain
_piled_store = _IMPL._piled_store
_repo_with_fake_table = _IMPL._repo_with_fake_table
_schema = _IMPL._schema
_slot_histogram = _IMPL._slot_histogram
_throttle = _IMPL._throttle


class _NetworkError(Exception):
    """A BotoCoreError stand-in: a connect/read timeout is NOT a ClientError, so it takes
    _write_color_slots' bare `except Exception` arm."""


def _only_the_migration_write_fails(repo, error):
    """Make ONLY the colour-slot write fail, leaving create/update/delete healthy.

    Setting FakeTable.update_error makes EVERY write fail, so create's own conditional write
    would raise the same exception and a test could not tell which call site propagated it.
    Routed on the ABSENCE of #id — the same discriminator FakeTable itself uses to recognise
    the migration's write shape."""
    real = repo._table.update_item

    def _update_item(**kwargs):
        if "#id" not in kwargs["ExpressionAttributeNames"]:
            raise error
        return real(**kwargs)

    repo._table.update_item = _update_item


def _levelled(repo) -> bool:
    """Is every colour worn by no more categories than the ramp forces? Spelled out here
    rather than imported: a helper that called _repaint_allowance would agree with a broken
    allowance and prove nothing."""
    holders = _slot_histogram(repo)
    rows = sum(holders.values())
    return max(holders.values()) <= max(1, -(-rows // 20))


# --- [A1]-[A4], [A14] the write policy, driven through a REPAINT chunk --------


def test_a_read_fails_open_when_the_repaint_chunk_is_throttled(handler):
    """WHIT-428 — [A1] a throttled REPAINT must not 500 the seven read routes.

    The impl suite proves this for the BACKFILL. The repaint is a second call site with a
    different plan and settled=True; nothing drove a throttle through it. Flip the
    strict=False argument in list_categories and this reddens.
    """
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 40)               # 53 rows, all customs on slot 0
    before = {cid: int(cat[_SLOT])
              for cid, cat in repo._table.store[_CFG]["items"].items()}
    repo._table.update_error = _throttle()

    rows = repo.list_categories()                    # must not raise

    # The response is still the LEVELLED preview, computed in memory from the plan.
    assert max(Counter(row[_SLOT] for row in rows).values()) <= 3
    assert len(rows) == 53
    # Nothing landed and the marker is untouched, so a later read retries the whole thing.
    assert {cid: int(cat[_SLOT])
            for cid, cat in repo._table.store[_CFG]["items"].items()} == before
    assert repo._table.store[_CFG]["colorSlotSchema"] == 1

    repo._table.update_error = None
    _drain(repo, limit=40)
    assert _levelled(repo)
    assert repo._table.store[_CFG]["colorSlotSchema"] == _schema()


def test_a_read_fails_open_when_the_repaint_chunk_hits_a_network_error(handler):
    """WHIT-428 — [A2] a timeout is not a ClientError. Through a repaint plan it must still
    be swallowed on the read path, or /breakdown, /budgets, /insights and the webhook's
    budget-alert path all 500 on a store that has simply not finished levelling."""
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 40)
    repo._table.update_error = _NetworkError("connection reset by peer")

    rows = repo.list_categories()                    # must not raise

    assert len(rows) == 53
    assert all(isinstance(row[_SLOT], int) and 0 <= row[_SLOT] < 20 for row in rows)
    assert repo._table.store[_CFG]["colorSlotSchema"] == 1


def test_a_create_fails_closed_on_a_network_error_in_the_repaint_chunk(handler):
    """WHIT-428 — [A3] the opposite policy, on the branch NOTHING covers today.

    test_create_fails_closed_when_the_backfill_write_errors drives a ClientError, which exits
    via handle_database_error. The bare `except Exception: if strict: raise` is the only path
    a timeout takes on a write, and it had no test. Swap that `raise` for a `pass` and the
    POST silently reports a colour it never stored; this reddens.
    """
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 40)
    # ONLY the repaint chunk fails: if create's own write failed too, the exception would
    # propagate from there and the test would pass however _write_color_slots behaved.
    _only_the_migration_write_fails(repo, _NetworkError("connection reset by peer"))

    with pytest.raises(_NetworkError):
        repo.create_category("wine", "Wine", "Lifestyle", "glass")

    assert "wine" not in repo._table.store[_CFG]["items"], \
        "the create landed on top of a migration write that never happened"
    assert repo._table.store[_CFG]["colorSlotSchema"] == 1


def test_a_version_race_inside_a_repaint_chunk_writes_nothing_and_recovers(handler):
    """WHIT-428 — [A4] a concurrent writer bumps the version between the repaint's read and
    its conditional write. The chunk must be a no-op success (not a 409 on a GET), leave every
    stored colour alone, leave the marker unstamped, and be picked up by the next read."""
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 60)
    before = {cid: int(cat[_SLOT])
              for cid, cat in repo._table.store[_CFG]["items"].items()}
    # A concurrent writer lands between our get_item and our update_item.
    repo._table.before_update.append(
        lambda item: item.__setitem__("version", item["version"] + Decimal(1)))

    rows = repo.list_categories()                    # must not raise, must not 409

    assert len(rows) == 73
    assert {cid: int(cat[_SLOT])
            for cid, cat in repo._table.store[_CFG]["items"].items()} == before
    assert repo._table.store[_CFG]["colorSlotSchema"] == 1

    _drain(repo, limit=40)
    assert _levelled(repo)
    assert repo._table.store[_CFG]["colorSlotSchema"] == _schema()


def test_two_readers_racing_one_repaint_chunk_agree_on_every_colour(handler):
    """WHIT-428 — [A14] two Lambda invocations read the same store, both plan the repaint, one
    write wins. The loser must return the SAME colour map — the planner is pure, so losing the
    race costs nothing — and must not raise."""
    repository, repo_a = _repo_with_fake_table(handler)
    _piled_store(repo_a, repository, 60)
    repo_b = repository.CategoryRepository()
    repo_b._table = repo_a._table                    # same table, second invocation
    seen = {}

    # B does a whole read (and lands its own chunk) between A's read and A's write.
    def _b_goes_first(_item):
        seen["b"] = {row["id"]: row[_SLOT] for row in repo_b.list_categories()}

    repo_a._table.before_update.append(_b_goes_first)

    seen["a"] = {row["id"]: row[_SLOT] for row in repo_a.list_categories()}

    assert seen["a"] == seen["b"], "two concurrent readers disagreed about a colour"
    # A lost the version race, so exactly ONE chunk landed: B's.
    assert len(repo_a._table.update_calls) == 2      # A's rejected attempt + B's write
    assert repo_a._table.store[_CFG]["version"] == 2


# --- [A5]-[A6] marker semantics ----------------------------------------------


def test_a_store_stamped_beyond_schema_two_is_left_completely_alone(handler):
    """WHIT-428 — [A5] _is_slot_migrated compares `>=`, so a store a FUTURE migration already
    stamped 3 must not be dragged back through this one. Change that `>=` to `==` and a piled
    schema-3 store repaints and re-stamps itself down to 2, which is how a two-way version
    flap between deploys starts."""
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 40, schema=3)
    before = {cid: int(cat[_SLOT])
              for cid, cat in repo._table.store[_CFG]["items"].items()}

    for _ in range(3):
        repo.list_categories()

    assert repo._table.update_calls == []
    assert {cid: int(cat[_SLOT])
            for cid, cat in repo._table.store[_CFG]["items"].items()} == before
    assert repo._table.store[_CFG]["colorSlotSchema"] == 3


def test_write_color_slots_refuses_to_be_called_without_settled(handler):
    """WHIT-428 — [A6] `settled` is keyword-only with NO default, on purpose: a call site that
    forgets it would stamp schema 2 early and strand the repaint's rows on a shared colour
    FOREVER — a silent permanent bug rather than a loud one. Give it a default and this
    reddens."""
    import repository_category

    parameter = inspect.signature(
        repository_category.CategoryRepository._write_color_slots).parameters["settled"]

    assert parameter.kind is inspect.Parameter.KEYWORD_ONLY
    assert parameter.default is inspect.Parameter.empty
    with pytest.raises(TypeError):
        repository_category.CategoryRepository()._write_color_slots(
            Decimal(1), {}, strict=False)


# --- [A7]-[A8] the repaint's own chunk / expression boundaries ---------------


@pytest.mark.parametrize("piled, movers, writes", [(53, 50, 1), (54, 51, 2)])
def test_a_repaint_of_exactly_one_chunk_settles_in_one_write(handler, piled, movers, writes):
    """WHIT-428 — [A7] the repaint's chunk boundary, both sides. Exactly
    _COLOR_SLOT_WRITE_CHUNK movers must drain AND stamp in a single write; one more must take
    two, with the marker withheld until the second. An off-by-one in `drained`, or a change to
    the chunk cap, moves one of these two."""
    repository, repo = _repo_with_fake_table(handler)
    import repository_category
    _piled_store(repo, repository, piled)
    assert repository_category._COLOR_SLOT_WRITE_CHUNK == 50, "fixture drifted with the cap"
    plan = repository.plan_color_slot_repaint(repo._table.store[_CFG]["items"])
    assert len(plan) == movers, "fixture drifted: wrong number of movers"

    repo.list_categories()
    first_write_stamped = repo._table.store[_CFG]["colorSlotSchema"] == _schema()

    assert first_write_stamped is (writes == 1)
    assert _drain(repo, limit=10) == writes
    assert repo._table.store[_CFG]["colorSlotSchema"] == _schema()
    assert _levelled(repo)


@pytest.mark.parametrize("clauses, fits", [(129, True), (130, False)])
def test_the_documented_4kb_clause_boundary_is_exactly_where_the_comment_says(
    handler, monkeypatch, clauses, fits
):
    """WHIT-428 — [A8] _COLOR_SLOT_WRITE_CHUNK's comment claims 129 clauses (4070 bytes) is the
    last that fits and 130 (4103) is rejected. The repaint now rides the SAME write shape, so
    that arithmetic guards two migrations, not one — and nothing checked it. Raise the chunk
    to the claimed ceiling and the write must still land; one past it and the real service
    (and FakeTable) reject the expression, which on a read is swallowed and leaves the store
    unstamped forever.

    Note the numbers only hold WITH the marker clause in the same write, so the plan is sized
    to drain in one. A partial chunk is 33 bytes smaller.
    """
    repository, repo = _repo_with_fake_table(handler)
    import repository_category
    monkeypatch.setattr(repository_category, "_COLOR_SLOT_WRITE_CHUNK", clauses)
    items = {f"cat{index:04d}": _cat(f"cat{index:04d}") for index in range(clauses)}
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": items,
                               "version": Decimal(1)}

    repo.list_categories()                           # fail-open: never raises either way

    expression = repo._table.update_calls[0][0]
    assert "#schema" in expression, "sized wrong: the marker clause must be in the write"
    assert len(expression.encode()) == (4070 if fits else 4103)
    assert (len(expression.encode()) <= _MAX_UPDATE_EXPRESSION_BYTES) is fits
    stamped = repo._table.store[_CFG].get("colorSlotSchema") == _schema()
    assert stamped is fits, "an over-4KB write appeared to succeed"


# --- [A9]-[A10] preview leaks ------------------------------------------------


def test_planning_a_stage_never_mutates_the_rows_the_response_is_built_from(handler):
    """WHIT-428 — [A9] `settled` is decided by re-planning the repaint over `_with_slots`, the
    store as it WILL read. Those rows are the same dicts list_categories builds its response
    from, so writing the slot in place would hand the client colours the store does not hold
    and will not hold for several more requests. Make _with_slots apply instead of project and
    this reddens."""
    import repository

    items = {cat_id: dict(cat) for cat_id, cat in repository.SEED_CATEGORIES.items()}
    for index in range(30):
        items[f"cat{index:04d}"] = _cat(f"cat{index:04d}", colorSlot=Decimal(0))
    items["zzunslotted"] = _cat("zzunslotted")
    snapshot = copy.deepcopy(items)

    plan, settled = repository.plan_color_slot_stage(items, repainted=False)

    assert plan == {"zzunslotted": plan["zzunslotted"]}, "the backfill stage must come first"
    assert settled is False, "a repaint still follows, so this plan cannot stamp"
    assert items == snapshot, "planning mutated the rows the response is built from"


def test_a_read_mid_backfill_shows_stored_colours_not_the_repaint_it_is_about_to_do(handler):
    """WHIT-428 — [A10] the same leak, end to end. While the BACKFILL stage is the one being
    persisted, a piled row must still read the colour it actually holds. Showing the repaint's
    preview here would repaint the chart a request early — and then again when the allowance
    shifts under a create."""
    repository, repo = _repo_with_fake_table(handler)
    items = {cat_id: dict(cat) for cat_id, cat in repository.SEED_CATEGORIES.items()}
    for index in range(30):
        items[f"cat{index:04d}"] = _cat(f"cat{index:04d}", colorSlot=Decimal(0))
    items["zzunslotted"] = _cat("zzunslotted")
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": items,
                               "version": Decimal(1), "colorSlotSchema": Decimal(1)}

    rows = {row["id"]: row[_SLOT] for row in repo.list_categories()}

    assert {rows[f"cat{index:04d}"] for index in range(30)} == {0}, \
        "a piled row previewed its repaint colour while the backfill was still draining"
    previewed = rows["zzunslotted"]                  # the backfill's own row IS previewed
    assert isinstance(previewed, int) and 0 <= previewed < 20 and previewed != 0
    assert repo._table.store[_CFG]["colorSlotSchema"] == 1, "stamped before the repaint ran"

    _drain(repo, limit=40)
    assert _levelled(repo)
    assert repo._table.store[_CFG]["colorSlotSchema"] == _schema()


# --- [A11] the assigner's new `protected` tier -------------------------------


def test_protected_only_bites_once_every_slot_is_owed(handler):
    """WHIT-428 — [A11] `protected` is the SECOND tier: while any slot is un-owed it must not
    change the answer at all, and when a caller protects everything the fallback must still
    return a slot rather than raising ValueError on min([]) — that would 500 a POST.
    Drop the `spare or range(...)` guard and the second half reddens."""
    import repository

    counts = Counter({slot: 1 for slot in range(20)})
    every_slot = frozenset(range(20))

    # Nothing is reserved, so protected is irrelevant and the ordinary least-held answer wins.
    assert (repository.least_held_color_slot(counts, frozenset(), every_slot)
            == repository.least_held_color_slot(counts, frozenset()))
    # Every slot owed AND every slot protected: defensive, but it must not raise.
    slot = repository.least_held_color_slot(counts, every_slot, every_slot)
    assert isinstance(slot, int) and 0 <= slot < 20


# --- [A12]-[A13] hostile stored data -----------------------------------------


def test_a_repaint_moves_rows_whose_ids_are_hostile_to_dynamodb(handler):
    """WHIT-428 — [A12] the repaint stamps `#items.#catN.#slot`. A row keyed by a DynamoDB
    reserved word, or one carrying a dot (which would be read as a nested path if it were ever
    inlined), or unicode + whitespace, must land on exactly that map key. Inline any id into
    the expression and DynamoDB either mis-writes a nested path or rejects the reserved word —
    and on the read path that failure is SWALLOWED, so the store would simply never level."""
    repository, repo = _repo_with_fake_table(handler)
    hostile = ["a.b", "Size", "NAME", "with space", "café — unicode"]
    items = {cat_id: dict(cat) for cat_id, cat in repository.SEED_CATEGORIES.items()}
    for cat_id in hostile:
        items[cat_id] = _cat(cat_id, colorSlot=Decimal(0))
    for index in range(20):
        items[f"cat{index:04d}"] = _cat(f"cat{index:04d}", colorSlot=Decimal(0))
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": items,
                               "version": Decimal(1), "colorSlotSchema": Decimal(1)}

    _drain(repo, limit=40)

    stored = repo._table.store[_CFG]["items"]
    for cat_id in hostile:
        assert cat_id in stored, f"{cat_id!r} lost its map key"
        assert 0 <= int(stored[cat_id][_SLOT]) < 20
    assert any(int(stored[cat_id][_SLOT]) != 0 for cat_id in hostile), \
        "fixture drifted: no hostile row was actually moved by the repaint"
    expressions = " ".join(call[0] for call in repo._table.update_calls)
    for cat_id in hostile:
        assert cat_id not in expressions, f"{cat_id!r} was inlined instead of aliased"
    assert _levelled(repo)
    assert repo._table.store[_CFG]["colorSlotSchema"] == _schema()


def test_corrupt_slots_on_top_of_a_pile_still_settle_level_and_stamp_once(handler):
    """WHIT-428 — [A13] the two stages meeting on hostile data: rows whose stored slot is a
    string / float / bool / negative / out-of-range are ABSENT to the histogram but PRESENT in
    the row count the allowance is derived from. Both stages must still run, in order, and the
    store must settle level with no corrupt value surviving — then stay silent."""
    repository, repo = _repo_with_fake_table(handler)
    items = {cat_id: dict(cat) for cat_id, cat in repository.SEED_CATEGORIES.items()}
    corrupt = {"zs": "7", "zf": Decimal("7.5"), "zn": Decimal(-5), "zb": True,
               "zo": Decimal(999)}
    for cat_id, raw in corrupt.items():
        items[cat_id] = _cat(cat_id, colorSlot=raw)
    for index in range(40):
        items[f"cat{index:04d}"] = _cat(f"cat{index:04d}", colorSlot=Decimal(0))
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": items,
                               "version": Decimal(1), "colorSlotSchema": Decimal(1)}

    _drain(repo, limit=40)

    stored = repo._table.store[_CFG]["items"]
    for cat_id in corrupt:
        value = stored[cat_id][_SLOT]
        assert not isinstance(value, (str, bool)) and 0 <= int(value) < 20 \
            and Decimal(value) == int(value), f"{cat_id} kept a corrupt slot: {value!r}"
    assert _levelled(repo)
    assert repo._table.store[_CFG]["colorSlotSchema"] == _schema()
    repo._table.update_calls.clear()
    repo.list_categories()
    assert repo._table.update_calls == [], "the migration ran a second time"


# --- [A15]-[A16] handler level: criterion 6, no new way to 500 ---------------


def test_get_categories_mid_repaint_is_a_200_even_when_the_write_is_throttled(handler,
                                                                              monkeypatch):
    """WHIT-428 — [A15] the read routes, at the HTTP boundary. GET /categories is the shape
    every other category read (and shared/budget_alerts.py fire_if_crossed) shares: it must be
    a 200 carrying id/name/bucket for every row, mid-repaint, with the migration write
    failing."""
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 60)
    repo._table.update_error = _throttle()
    monkeypatch.setattr(handler, "CategoryRepository", lambda: repo)

    response = handler.lambda_handler(
        {"rawPath": "/categories", "requestContext": {"http": {"method": "GET"}}}, None)

    assert response["statusCode"] == 200
    body = json.loads(response["body"])
    assert len(body) == 73
    # budget_alerts.fire_if_crossed keys names/buckets off exactly these three fields.
    assert all(row["id"] and row["name"] and row["bucket"] for row in body)
    assert all(isinstance(row[_SLOT], int) and 0 <= row[_SLOT] < 20 for row in body)


def test_post_categories_mid_repaint_returns_201_and_a_plain_integer_slot(handler,
                                                                         monkeypatch):
    """WHIT-428 — [A16] POST mid-repaint. The created colour must reach the client as a JSON
    integer (the repo converts the stored Decimal back to int for exactly this reason), and it
    must be the colour the store finally settles on."""
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 60)
    monkeypatch.setattr(handler, "CategoryRepository", lambda: repo)
    monkeypatch.setattr(handler, "BudgetRepository", lambda: _IMPL.FakeBudgetRepo())

    response = handler.lambda_handler(_categories_event(), None)

    assert response["statusCode"] == 201
    body = json.loads(response["body"])
    assert type(body[_SLOT]) is int and 0 <= body[_SLOT] < 20

    _drain(repo, limit=40)
    stored = repo._table.store[_CFG]["items"][body["id"]]
    assert int(stored[_SLOT]) == body[_SLOT], \
        "the repaint evicted the colour POST already returned to the client"
    assert _levelled(repo)


# --- [A17]-[A18] convergence and the neighbouring write paths ----------------


def test_a_very_large_piled_store_converges_without_ever_breaching_4kb(handler):
    """WHIT-428 — [A17] scale. A store far past anything the impl suite drains must still
    finish, in ceil(movers / chunk) writes and no more, with every expression inside the 4KB
    cap and the marker written exactly once, at the end."""
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 587)              # 600 rows, allowance 30
    import repository_category
    movers = len(repository.plan_color_slot_repaint(repo._table.store[_CFG]["items"]))
    chunk = repository_category._COLOR_SLOT_WRITE_CHUNK

    writes = _drain(repo, limit=movers // chunk + 5)

    assert writes == -(-movers // chunk)
    assert max(len(call[0].encode()) for call in repo._table.update_calls) \
        < _MAX_UPDATE_EXPRESSION_BYTES
    assert _levelled(repo)
    assert sum(1 for call in repo._table.update_calls if ":schema" in call[2]) == 1


def test_update_and_delete_mid_repaint_land_on_their_first_attempt(handler):
    """WHIT-428 — [A18] the two write paths that do NOT drain the migration. Neither may be
    dragged into a version race by it: a PATCH or DELETE mid-repaint must take exactly one
    write each, and must not undo a chunk that already landed."""
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 60)
    repo.list_categories()                           # land one repaint chunk
    assert repo._table.store[_CFG]["colorSlotSchema"] == 1, "fixture drifted: it settled"
    landed = {cat_id: int(cat[_SLOT])
              for cat_id, cat in repo._table.store[_CFG]["items"].items()}
    repo._table.update_calls.clear()

    repo.update_category("cat0000", "Renamed", "Living", "tag")
    repo.delete_category("cat0001")

    assert len(repo._table.update_calls) == 2, "a neighbouring write retried"
    stored = repo._table.store[_CFG]["items"]
    assert stored["cat0000"]["name"] == "Renamed"
    assert int(stored["cat0000"][_SLOT]) == landed["cat0000"]
    assert "cat0001" not in stored
    _drain(repo, limit=40)
    assert repo._table.store[_CFG]["colorSlotSchema"] == _schema()
