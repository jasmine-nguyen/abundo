"""Unit tests for BudgetRepository.delete_budget (WHIT-73): the cascade run when a
category is deleted, so a stale target can't linger and silently reappear if a
same-slug category is re-created.

The BUDGETS item uses a nested-map REMOVE + version SET under an optimistic lock,
which the shared FakeTable can't model, so these tests use the shared
``config_item_table`` fake from conftest (WHIT-251).
"""

from decimal import Decimal

import pytest


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

    assert "groceries" not in table.item["items"]
    assert "coffee" in table.item["items"]          # only the one key removed
    assert table.item["version"] == Decimal(2)      # version bumped once
    assert table.update_calls == 1


def test_delete_budget_absent_target_is_a_silent_noop(shared, budget_repo, config_item_table):
    # The common case: the deleted category never had a budget. No write, no bump.
    table = config_item_table("BUDGETS", items={"coffee": {"target": Decimal(60)}}, version=5)
    _with_table(budget_repo, table)

    budget_repo.delete_budget("groceries")

    assert table.update_calls == 0                   # never touched the item
    assert table.item["version"] == Decimal(5)       # version unchanged
    assert "coffee" in table.item["items"]


def test_delete_budget_no_config_item_is_a_noop(shared, budget_repo, config_item_table):
    # No target was ever set -> the BUDGETS item doesn't exist. Nothing to cascade.
    table = config_item_table("BUDGETS", present=False)
    _with_table(budget_repo, table)

    budget_repo.delete_budget("groceries")

    assert table.update_calls == 0


def test_delete_budget_retries_once_under_a_version_race(shared, budget_repo, config_item_table):
    table = config_item_table("BUDGETS", items={"groceries": {"target": Decimal(300)}})
    table.race_next_update()   # first update loses the lock; repo re-reads + retries
    _with_table(budget_repo, table)

    budget_repo.delete_budget("groceries")

    assert "groceries" not in table.item["items"]    # converged after the retry
    assert table.update_calls == 2


def test_delete_budget_raises_a_conflict_when_it_cannot_converge(shared, budget_repo, config_item_table):
    from repository_errors import VersionConflictError

    table = config_item_table("BUDGETS", items={"groceries": {"target": Decimal(300)}})
    table.always_race()   # every attempt loses the lock -> exhausts the retry budget
    _with_table(budget_repo, table)

    with pytest.raises(VersionConflictError):
        budget_repo.delete_budget("groceries")
    assert "groceries" in table.item["items"]        # never removed


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

    entry = table.item["items"]["groceries"]
    assert entry["target"] == Decimal(350)            # amount updated
    assert entry["rollover"] is True                  # NOT clobbered
    assert entry["carryover"] == Decimal(40)          # accumulated buffer preserved
    assert entry["carryover_from"] == "2026-08-06"


def test_set_budget_creates_a_brand_new_entry(shared, budget_repo, config_item_table):
    # The items.<id> map key doesn't exist yet — the whole-entry SET must create it cleanly
    # (a nested per-field SET would error on the missing parent map).
    table = config_item_table("BUDGETS", items={})
    _with_table(budget_repo, table)

    budget_repo.set_budget("coffee", Decimal(58))

    assert table.item["items"]["coffee"] == {"target": Decimal(58)}


def test_set_budget_with_rollover_and_anchor_writes_the_anchor_fields(shared, budget_repo, config_item_table):
    table = config_item_table("BUDGETS", items={"coffee": {"target": Decimal(58)}})
    _with_table(budget_repo, table)
    anchor = {"carryover_from": "2026-08-06", "carryover_len": Decimal(30), "carryover_paydate": "2026-01-01"}

    budget_repo.set_budget("coffee", Decimal(60), rollover=True, anchor=anchor)

    entry = table.item["items"]["coffee"]
    assert entry["target"] == Decimal(60)
    assert entry["rollover"] is True
    assert entry["carryover_from"] == "2026-08-06"
    assert entry["carryover_len"] == Decimal(30)
    assert entry["carryover_paydate"] == "2026-01-01"


def test_settle_carryover_persists_balance_and_anchor_preserving_target(shared, budget_repo, config_item_table):
    table = config_item_table("BUDGETS", items={"coffee": {"target": Decimal(58), "rollover": True}})
    _with_table(budget_repo, table)

    budget_repo.settle_carryover("coffee", Decimal(200), "2026-07-07", 30, "2026-01-01")

    entry = table.item["items"]["coffee"]
    assert entry["carryover"] == Decimal(200)
    assert entry["carryover_from"] == "2026-07-07"
    assert entry["carryover_len"] == Decimal(30)
    assert entry["carryover_paydate"] == "2026-01-01"
    assert entry["target"] == Decimal(58)   # not wiped by the settle
    assert entry["rollover"] is True         # flag preserved


def test_settle_carryover_retries_once_under_a_version_race(shared, budget_repo, config_item_table):
    table = config_item_table("BUDGETS", items={"coffee": {"target": Decimal(58), "rollover": True}})
    table.race_next_update()   # first update loses the lock; repo re-reads + retries
    _with_table(budget_repo, table)

    budget_repo.settle_carryover("coffee", Decimal(-25), "2026-07-07", 30, "2026-01-01")

    assert table.item["items"]["coffee"]["carryover"] == Decimal(-25)  # negative buffer converges
    assert table.update_calls == 2


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

    assert table.item["items"]["coffee"] == {"target": Decimal(300)}   # only the target survives
    assert table.item["items"]["food"] == {"target": Decimal(80)}      # a sibling entry is untouched
    assert table.item["version"] == Decimal(2)                          # bumped once
    assert table.update_calls == 1


def test_clear_rollover_strips_a_partial_rollover_entry(shared, budget_repo, config_item_table):
    # A REMOVE of an already-absent field is a no-op — an entry with only SOME rollover fields
    # still ends as a plain {target}, no crash.
    partial = {"target": Decimal(50), "rollover": False, "carryover_from": "2026-08-06", "carryover_len": Decimal(30)}
    table = config_item_table("BUDGETS", items={"coffee": partial})
    _with_table(budget_repo, table)

    budget_repo.clear_rollover("coffee")

    assert table.item["items"]["coffee"] == {"target": Decimal(50)}
    assert table.item["version"] == Decimal(2)


def test_clear_rollover_absent_entry_is_a_silent_noop(shared, budget_repo, config_item_table):
    # No budget for this id -> nothing to clear, no seed, no version bump.
    table = config_item_table("BUDGETS", items={"food": {"target": Decimal(80)}}, version=5)
    _with_table(budget_repo, table)

    budget_repo.clear_rollover("coffee")

    assert table.update_calls == 0
    assert table.item["version"] == Decimal(5)


def test_clear_rollover_plain_target_entry_is_a_noop(shared, budget_repo, config_item_table):
    # An entry that carries only a target (no rollover fields) is already clean — no write,
    # no version bump, so a plain edit of a non-rollover budget can't cause write contention.
    table = config_item_table("BUDGETS", items={"coffee": {"target": Decimal(58)}}, version=3)
    _with_table(budget_repo, table)

    budget_repo.clear_rollover("coffee")

    assert table.update_calls == 0
    assert table.item["version"] == Decimal(3)
    assert table.item["items"]["coffee"] == {"target": Decimal(58)}


def test_clear_rollover_no_config_item_is_a_noop(shared, budget_repo, config_item_table):
    table = config_item_table("BUDGETS", present=False)
    _with_table(budget_repo, table)

    budget_repo.clear_rollover("coffee")

    assert table.update_calls == 0


def test_clear_rollover_retries_once_under_a_version_race(shared, budget_repo, config_item_table):
    table = config_item_table("BUDGETS", items={"coffee": _rollover_entry()})
    table.race_next_update()   # first update loses the lock; repo re-reads + retries
    _with_table(budget_repo, table)

    budget_repo.clear_rollover("coffee")

    assert table.item["items"]["coffee"] == {"target": Decimal(300)}   # converged after the retry
    assert table.update_calls == 2


def test_clear_rollover_raises_a_conflict_when_it_cannot_converge(shared, budget_repo, config_item_table):
    from repository_errors import VersionConflictError

    table = config_item_table("BUDGETS", items={"coffee": _rollover_entry()})
    table.always_race()   # every attempt loses the lock -> exhausts the retry budget
    _with_table(budget_repo, table)

    with pytest.raises(VersionConflictError):
        budget_repo.clear_rollover("coffee")
    assert "rollover" in table.item["items"]["coffee"]   # never cleared


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
    budget_repo.settle_carryover("coffee", Decimal(20), "2026-08-06", 30, "2026-01-01")

    persisted_rollover_keys = set(table.item["items"]["coffee"].keys()) - {"target"}
    assert persisted_rollover_keys == set(shared.budget._ROLLOVER_FIELDS)
