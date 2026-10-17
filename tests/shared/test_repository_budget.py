"""Unit tests for BudgetRepository.delete_budget (WHIT-73): the cascade run when a
category is deleted, so a stale target can't linger and silently reappear if a
same-slug category is re-created.

The BUDGETS item uses a nested-map REMOVE + version SET under an optimistic lock; the real
repository runs over the shared FakeTable, seeded per test by conftest's
``config_item_table`` (WHIT-251, WHIT-625).
"""

from decimal import Decimal

import pytest

_KEY = ("BUDGETS", "BUDGETS")  # the config item's store key in FakeTable


@pytest.fixture
def budget_repo(shared):
    r = shared.budget.BudgetRepository()
    r._table = None  # ensure the lazy boto3 path is never taken
    return r


def _with_table(budget_repo, table):
    budget_repo._table = table
    return budget_repo


def test_delete_budget_removes_an_existing_target(shared, budget_repo, config_item_table):
    table = config_item_table("BUDGETS", items={"groceries": {"target": Decimal(300)}, "coffee": {"target": Decimal(60)}})
    _with_table(budget_repo, table)

    budget_repo.delete_budget("groceries")

    assert "groceries" not in table.store[_KEY]["items"]
    assert "coffee" in table.store[_KEY]["items"]          # only the one key removed
    assert table.store[_KEY]["version"] == Decimal(2)      # version bumped once
    assert len(table.update_calls) == 1


def test_delete_budget_absent_target_is_a_silent_noop(shared, budget_repo, config_item_table):
    # The common case: the deleted category never had a budget. No write, no bump.
    table = config_item_table("BUDGETS", items={"coffee": {"target": Decimal(60)}}, version=5)
    _with_table(budget_repo, table)

    budget_repo.delete_budget("groceries")

    assert len(table.update_calls) == 0                   # never touched the item
    assert table.store[_KEY]["version"] == Decimal(5)       # version unchanged
    assert "coffee" in table.store[_KEY]["items"]


# --- set_budget preserves rollover fields + settle_carryover (budget rollover) ---


def test_set_budget_preserves_rollover_fields_on_an_amount_edit(shared, budget_repo, config_item_table):
    # FAIL-ON-REVERT for the clobber fix: a plain amount edit must merge onto the existing
    # entry, never replace it — a stored carryover/rollover survives untouched.
    table = config_item_table("BUDGETS", items={"groceries": {
        "target": Decimal(300), "rollover": True, "carryover": Decimal(40),
        "carryover_from": "2026-08-06", "carryover_len": Decimal(30), "carryover_paydate": "2026-01-01",
    }})
    _with_table(budget_repo, table)

    budget_repo.set_budget("groceries", Decimal(350))

    entry = table.store[_KEY]["items"]["groceries"]
    assert entry["target"] == Decimal(350)            # amount updated
    assert entry["rollover"] is True                  # NOT clobbered
    assert entry["carryover"] == Decimal(40)          # accumulated buffer preserved
    assert entry["carryover_from"] == "2026-08-06"


def test_set_budget_creates_a_brand_new_entry(shared, budget_repo, config_item_table):
    # The items.<id> map key doesn't exist yet — the whole-entry SET must create it cleanly
    # (a nested per-field SET would error on the missing parent map).
    table = config_item_table("BUDGETS", items={"food": {"target": Decimal(80)}})
    _with_table(budget_repo, table)

    budget_repo.set_budget("coffee", Decimal(58))

    assert table.store[_KEY]["items"]["coffee"] == {"target": Decimal(58)}
    assert table.store[_KEY]["items"]["food"] == {"target": Decimal(80)}   # another budget survives


def test_set_budget_with_rollover_and_anchor_writes_the_anchor_fields(shared, budget_repo, config_item_table):
    table = config_item_table("BUDGETS", items={"coffee": {"target": Decimal(58)}})
    _with_table(budget_repo, table)
    anchor = {"carryover_from": "2026-08-06", "carryover_len": Decimal(30), "carryover_paydate": "2026-01-01"}

    budget_repo.set_budget("coffee", Decimal(60), rollover=True, anchor=anchor)

    entry = table.store[_KEY]["items"]["coffee"]
    assert entry["target"] == Decimal(60)
    assert entry["rollover"] is True
    assert entry["carryover_from"] == "2026-08-06"
    assert entry["carryover_len"] == Decimal(30)
    assert entry["carryover_paydate"] == "2026-01-01"


def test_settle_carryover_persists_balance_and_anchor_preserving_target(shared, budget_repo, config_item_table):
    table = config_item_table("BUDGETS", items={"coffee": {"target": Decimal(58), "rollover": True}})
    _with_table(budget_repo, table)

    budget_repo.settle_carryover("coffee", Decimal(200), "2026-07-07", 30, "2026-01-01")

    entry = table.store[_KEY]["items"]["coffee"]
    assert entry["carryover"] == Decimal(200)
    assert entry["carryover_from"] == "2026-07-07"
    assert entry["carryover_len"] == Decimal(30)
    assert entry["carryover_paydate"] == "2026-01-01"
    assert entry["target"] == Decimal(58)   # not wiped by the settle
    assert entry["rollover"] is True         # flag preserved
    assert "carryover_history" not in entry  # only saved when the seal passes one


def test_settle_carryover_saves_the_sealed_cycles_in_the_same_write(shared, budget_repo, config_item_table):
    old = {"start": "2026-06-07", "end": "2026-07-06", "target": Decimal(58), "spent": Decimal(60),
           "leftover": Decimal(-2)}
    new = {"start": "2026-07-07", "end": "2026-08-05", "target": Decimal(58), "spent": Decimal(8),
           "leftover": Decimal(50)}
    table = config_item_table("BUDGETS", items={"coffee": {
        "target": Decimal(58), "rollover": True, "carryover": Decimal(-2), "carryover_history": [old]}})
    _with_table(budget_repo, table)

    budget_repo.settle_carryover("coffee", Decimal(48), "2026-08-06", 30, "2026-01-01", [new, old])

    entry = table.store[_KEY]["items"]["coffee"]
    assert entry["carryover"] == Decimal(48)
    assert entry["carryover_history"] == [new, old]
    assert len(table.update_calls) == 1


def test_settle_carryover_without_history_keeps_the_stored_history(shared, budget_repo, config_item_table):
    # A re-anchor passes no history: the cycles already saved stay.
    old = {"start": "2026-06-07", "end": "2026-07-06", "target": Decimal(58), "spent": Decimal(60),
           "leftover": Decimal(-2)}
    table = config_item_table("BUDGETS", items={"coffee": {
        "target": Decimal(58), "rollover": True, "carryover": Decimal(-2), "carryover_history": [old]}})
    _with_table(budget_repo, table)

    budget_repo.settle_carryover("coffee", Decimal(-2), "2026-08-06", 14, "2026-08-01")

    assert table.store[_KEY]["items"]["coffee"]["carryover_history"] == [old]


# --- clear_rollover: strip rollover fields on a re-bucket out of spend (WHIT-474) ---


def _rollover_entry(target=300):
    return {
        "target": Decimal(target), "rollover": True, "carryover": Decimal(120),
        "carryover_from": "2026-08-06", "carryover_len": Decimal(30), "carryover_paydate": "2026-01-01",
    }


def test_clear_rollover_strips_the_fields_but_keeps_the_target(shared, budget_repo, config_item_table):
    # FAIL-ON-REVERT for the fix: the entry must lose every rollover field yet KEEP its target
    # (an Income budget is a valid earn-target — clearing the whole entry would destroy it).
    table = config_item_table("BUDGETS", items={"coffee": _rollover_entry(), "food": {"target": Decimal(80)}})
    _with_table(budget_repo, table)

    budget_repo.clear_rollover("coffee")

    assert table.store[_KEY]["items"]["coffee"] == {"target": Decimal(300)}   # only the target survives
    assert table.store[_KEY]["items"]["food"] == {"target": Decimal(80)}      # a sibling entry is untouched
    assert table.store[_KEY]["version"] == Decimal(2)                          # bumped once
    assert len(table.update_calls) == 1


@pytest.mark.parametrize("clear, cat_id, items", [
    pytest.param("clear_rollover", "coffee", {"coffee": {"target": Decimal(58)}}, id="rollover-plain-target"),
    pytest.param("clear_spread", "insurance", {"insurance": {"target": Decimal(250)}}, id="spread-plain-target"),
    pytest.param("clear_rollover", "coffee", {"food": {"target": Decimal(80)}}, id="rollover-absent-entry"),
])
def test_clearing_an_already_clean_entry_writes_nothing(shared, budget_repo, config_item_table, clear, cat_id, items):
    # Nothing to strip -> no write and no version bump, so a plain edit can't cause write contention.
    table = config_item_table("BUDGETS", items=items, version=3)
    _with_table(budget_repo, table)

    getattr(budget_repo, clear)(cat_id)

    assert len(table.update_calls) == 0
    assert table.store[_KEY]["version"] == Decimal(3)
    assert table.store[_KEY]["items"] == items


@pytest.mark.parametrize("clear", ["delete_budget", "clear_rollover", "clear_spread"])
def test_clearing_with_no_budgets_item_yet_writes_nothing(shared, budget_repo, config_item_table, clear):
    # No target was ever set -> no BUDGETS item. Must not crash (a 500 after the category
    # delete already landed) and must not seed an item nobody asked for.
    table = config_item_table("BUDGETS", present=False)
    _with_table(budget_repo, table)

    getattr(budget_repo, clear)("coffee")

    assert len(table.update_calls) == 0
    assert _KEY not in table.store


def test_rollover_fields_tuple_matches_what_the_writes_persist(shared, budget_repo, config_item_table):
    # GUARD (qa WHIT-474): _ROLLOVER_FIELDS is what clear_rollover strips. It MUST equal every
    # rollover key the writes can persist — set_budget(anchor) + settle_carryover — minus target.
    # If a future field is added to a write but not the tuple, clear_rollover would leave it
    # behind (a partial clear that reintroduces the WHIT-474 buffer resurrection). Tie the tuple
    # to the real writes so that drift fails HERE, loudly.
    table = config_item_table("BUDGETS", items={})
    _with_table(budget_repo, table)

    budget_repo.set_budget("coffee", Decimal(100), rollover=True, anchor={
        "carryover_from": "2026-08-06", "carryover_len": Decimal(30), "carryover_paydate": "2026-01-01"})
    budget_repo.settle_carryover("coffee", Decimal(20), "2026-08-06", 30, "2026-01-01", [
        {"start": "2026-07-07", "end": "2026-08-05", "target": Decimal(100), "spent": Decimal(80),
         "leftover": Decimal(20)}])

    persisted_rollover_keys = set(table.store[_KEY]["items"]["coffee"].keys()) - {"target"}
    assert persisted_rollover_keys == set(shared.budget._ROLLOVER_FIELDS)


# --- set_spread / clear_spread: a bill spread on a budget entry (WHIT-504) ---


def _spread_entry(target=250):
    return {
        "target": Decimal(target), "spread_amount": Decimal("1390.91"), "spread_cycles": Decimal(4),
        "spread_from": "2026-08-06", "spread_len": Decimal(30), "spread_paydate": "2026-01-01",
    }


def test_set_spread_writes_the_plan_and_keeps_the_target(shared, budget_repo, config_item_table):
    table = config_item_table("BUDGETS", items={"insurance": {"target": Decimal(250)}})
    _with_table(budget_repo, table)

    saved = budget_repo.set_spread("insurance", Decimal("1390.91"), 4, "2026-08-06", 30, "2026-01-01")

    assert saved == {"id": "insurance", "amount": Decimal("1390.91"), "cycles": 4}
    entry = table.store[_KEY]["items"]["insurance"]
    assert entry["target"] == Decimal(250)              # NOT clobbered by the spread write
    assert entry["spread_amount"] == Decimal("1390.91")
    assert entry["spread_cycles"] == Decimal(4)
    assert entry["spread_from"] == "2026-08-06"
    assert entry["spread_len"] == Decimal(30)
    assert entry["spread_paydate"] == "2026-01-01"


def test_set_spread_replaces_an_existing_plan(shared, budget_repo, config_item_table):
    # Spreading again on the same category is an upsert: the new amount/cycles/anchor win.
    table = config_item_table("BUDGETS", items={"insurance": _spread_entry()})
    _with_table(budget_repo, table)

    budget_repo.set_spread("insurance", Decimal("600.00"), 2, "2026-09-05", 30, "2026-01-01")

    entry = table.store[_KEY]["items"]["insurance"]
    assert entry["spread_amount"] == Decimal("600.00")
    assert entry["spread_cycles"] == Decimal(2)
    assert entry["spread_from"] == "2026-09-05"
    assert entry["target"] == Decimal(250)


def test_clear_spread_strips_the_plan_but_keeps_the_target(shared, budget_repo, config_item_table):
    # FAIL-ON-REVERT: every spread field goes, the target stays, a sibling entry is untouched.
    table = config_item_table("BUDGETS", items={"insurance": _spread_entry(), "food": {"target": Decimal(80)}})
    _with_table(budget_repo, table)

    budget_repo.clear_spread("insurance")

    assert table.store[_KEY]["items"]["insurance"] == {"target": Decimal(250)}
    assert table.store[_KEY]["items"]["food"] == {"target": Decimal(80)}
    assert table.store[_KEY]["version"] == Decimal(2)
    assert len(table.update_calls) == 1


def test_clear_spread_leaves_rollover_fields_alone_and_vice_versa(shared, budget_repo, config_item_table):
    # The two clears are independent strips: neither may reach into the other's fields.
    # (Prod never stores both on one entry — the write guards forbid it — but the repo
    # must not rely on that to be correct.)
    both = {**_rollover_entry(), **{k: v for k, v in _spread_entry().items() if k != "target"}}
    table = config_item_table("BUDGETS", items={"coffee": dict(both)})
    _with_table(budget_repo, table)

    budget_repo.clear_spread("coffee")
    assert table.store[_KEY]["items"]["coffee"] == _rollover_entry()    # rollover fields intact

    budget_repo.clear_rollover("coffee")
    assert table.store[_KEY]["items"]["coffee"] == {"target": Decimal(300)}


def test_spread_fields_tuple_matches_what_set_spread_persists(shared, budget_repo, config_item_table):
    # GUARD (mirrors the rollover one): SPREAD_ENTRY_FIELDS is what clear_spread strips, so it
    # MUST equal every key set_spread writes minus target — a field added to the write but
    # not the tuple would survive a clear and keep adjusting the spendable forever.
    table = config_item_table("BUDGETS", items={"insurance": {"target": Decimal(250)}})
    _with_table(budget_repo, table)

    budget_repo.set_spread("insurance", Decimal("1390.91"), 4, "2026-08-06", 30, "2026-01-01")

    persisted_spread_keys = set(table.store[_KEY]["items"]["insurance"].keys()) - {"target"}
    assert persisted_spread_keys == set(shared.spend.SPREAD_ENTRY_FIELDS)
    assert not set(shared.spend.SPREAD_ENTRY_FIELDS) & set(shared.budget._ROLLOVER_FIELDS)


# --- rollover OR spread, never both: the write makes it structural (WHIT-504) ---


def test_set_spread_strips_any_rollover_fields_in_the_same_write(shared, budget_repo, config_item_table):
    # The handler's guard is check-then-act; a lost race could otherwise land both. The
    # write itself resolves it: spreading strips rollover (last writer wins), target kept.
    table = config_item_table("BUDGETS", items={"coffee": _rollover_entry()})
    _with_table(budget_repo, table)

    budget_repo.set_spread("coffee", Decimal("100.00"), 2, "2026-08-06", 30, "2026-01-01")

    entry = table.store[_KEY]["items"]["coffee"]
    assert entry["target"] == Decimal(300)
    assert "spread_amount" in entry
    assert not set(shared.budget._ROLLOVER_FIELDS) & set(entry)


def test_turning_rollover_on_strips_any_spread_fields_in_the_same_write(shared, budget_repo, config_item_table):
    table = config_item_table("BUDGETS", items={"insurance": _spread_entry()})
    _with_table(budget_repo, table)
    anchor = {"carryover_from": "2026-08-06", "carryover_len": Decimal(30), "carryover_paydate": "2026-01-01"}

    budget_repo.set_budget("insurance", Decimal(250), rollover=True, anchor=anchor)

    entry = table.store[_KEY]["items"]["insurance"]
    assert entry["rollover"] is True
    assert not set(shared.spend.SPREAD_ENTRY_FIELDS) & set(entry)


def test_a_plain_target_edit_keeps_the_spread(shared, budget_repo, config_item_table):
    # Only turning rollover ON strips a spread; an amount edit (rollover omitted or false)
    # must leave the plan alone.
    for rollover in (None, False):
        table = config_item_table("BUDGETS", items={"insurance": _spread_entry()})
        _with_table(budget_repo, table)

        budget_repo.set_budget("insurance", Decimal(300), rollover=rollover)

        entry = table.store[_KEY]["items"]["insurance"]
        assert entry["target"] == Decimal(300)
        assert entry["spread_amount"] == Decimal("1390.91"), rollover


def test_the_strip_is_re_applied_on_a_version_race_retry(shared, budget_repo, config_item_table):
    # The race that matters: the competing writer merged rollover in between our read and
    # our write. The retry re-reads and must strip it again, not carry it through.
    table = config_item_table("BUDGETS", items={"coffee": _rollover_entry()})
    table.race_next_update()
    _with_table(budget_repo, table)

    budget_repo.set_spread("coffee", Decimal("100.00"), 2, "2026-08-06", 30, "2026-01-01")

    assert not set(shared.budget._ROLLOVER_FIELDS) & set(table.store[_KEY]["items"]["coffee"])
    assert len(table.update_calls) == 2


# --- set_spread_if_absent: the create-only spread write for rule auto-spread (WHIT-559) ---------

def test_set_spread_if_absent_creates_a_plan_when_the_category_has_a_target_and_none(
        shared, budget_repo, config_item_table):
    table = config_item_table("BUDGETS", items={"insurance": {"target": Decimal(250)}})
    _with_table(budget_repo, table)

    saved = budget_repo.set_spread_if_absent("insurance", Decimal("600.00"), 3,
                                             "2026-09-05", 30, "2026-01-01")

    assert saved == {"id": "insurance", "amount": Decimal("600.00"), "cycles": 3}
    entry = table.store[_KEY]["items"]["insurance"]
    assert entry["target"] == Decimal(250)
    assert entry["spread_amount"] == Decimal("600.00")
    assert entry["spread_cycles"] == Decimal(3)
    assert entry["spread_from"] == "2026-09-05"


def test_set_spread_if_absent_never_clobbers_an_existing_plan(
        shared, budget_repo, config_item_table):
    # FAIL-ON-REVERT for the create-only guard: a category that already carries a spread (a user's,
    # or an earlier rule seed) is left byte-identical and no version is bumped — the whole point of
    # "create once, never re-anchor".
    table = config_item_table("BUDGETS", items={"insurance": _spread_entry()})
    before = dict(table.store[_KEY]["items"]["insurance"])
    before_version = table.store[_KEY]["version"]
    _with_table(budget_repo, table)

    result = budget_repo.set_spread_if_absent("insurance", Decimal("999.00"), 2,
                                              "2026-12-01", 30, "2026-01-01")

    assert result is None
    assert table.store[_KEY]["items"]["insurance"] == before  # untouched
    assert table.store[_KEY]["version"] == before_version
    assert len(table.update_calls) == 0


@pytest.mark.parametrize("items", [
    pytest.param({"insurance": {"rollover": False}}, id="entry-without-target"),
    pytest.param({"food": {"target": Decimal(80)}}, id="absent-category"),
])
def test_set_spread_if_absent_skips_a_category_with_no_target(
        shared, budget_repo, config_item_table, items):
    # A spread needs a budget target (mirrors the user path's 400). No target -> no-op, no orphan.
    table = config_item_table("BUDGETS", items=items)
    _with_table(budget_repo, table)

    assert budget_repo.set_spread_if_absent("insurance", Decimal("600.00"), 3,
                                            "2026-09-05", 30, "2026-01-01") is None
    assert len(table.update_calls) == 0


def test_set_spread_if_absent_skips_a_rollover_category(
        shared, budget_repo, config_item_table):
    # A category has rollover OR a spread, never both — don't spread a rollover category.
    table = config_item_table("BUDGETS", items={"coffee": _rollover_entry()})
    _with_table(budget_repo, table)

    assert budget_repo.set_spread_if_absent("coffee", Decimal("600.00"), 3,
                                            "2026-09-05", 30, "2026-01-01") is None
    assert len(table.update_calls) == 0


def test_set_spread_if_absent_strips_lingering_rollover_fields_on_create(
        shared, budget_repo, config_item_table):
    # rollover OFF but a stale carryover buffer present: creating a spread strips it in the same
    # write, exactly as set_spread does (spread XOR rollover).
    entry = {"target": Decimal(250), "rollover": False, "carryover": Decimal("12.00"),
             "carryover_from": "2026-07-01", "carryover_len": Decimal(30),
             "carryover_paydate": "2026-01-01"}
    table = config_item_table("BUDGETS", items={"insurance": entry})
    _with_table(budget_repo, table)

    budget_repo.set_spread_if_absent("insurance", Decimal("600.00"), 3, "2026-09-05", 30, "2026-01-01")

    stored = table.store[_KEY]["items"]["insurance"]
    assert stored["spread_amount"] == Decimal("600.00")
    assert "carryover" not in stored and "carryover_from" not in stored
    assert stored["target"] == Decimal(250)


@pytest.mark.parametrize("write, args", [
    pytest.param("settle_carryover", (Decimal(40), "2026-09-05", 30, "2026-01-01"), id="settle"),
    pytest.param("set_spread", (Decimal("600.00"), 2, "2026-09-05", 30, "2026-01-01"), id="set-spread"),
    pytest.param("clear_spread", (), id="clear-spread"),
])
def test_a_write_given_a_stale_expected_entry_is_skipped(shared, budget_repo, config_item_table, write, args):
    # The read-path settle passes the entry it read; an edit since then must survive untouched.
    table = config_item_table("BUDGETS", items={"insurance": _spread_entry()}, version=3)
    _with_table(budget_repo, table)

    getattr(budget_repo, write)("insurance", *args, expected={"target": Decimal(250)})

    assert len(table.update_calls) == 0
    assert table.store[_KEY]["version"] == Decimal(3)
    assert table.store[_KEY]["items"] == {"insurance": _spread_entry()}
