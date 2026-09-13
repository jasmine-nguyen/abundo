"""WHIT-548 — adversarial GAP tests for the unified "Smoothing" mirror (buffer + payback_*)
dual-write + backfill in shared/repository_budget.py.

Complements tests/shared/test_repository_budget.py (which pins the happy-path dual-writes,
the clear-strips, and the basic backfill idempotency). These hit the corners that file skips:
a corrupt entry with BOTH old families, races DURING the dual-write and the backfill, a mixed
map mirrored in one write, a stale mirror that must be corrected + its orphan keys dropped, an
incomplete spread, orphan mirrors with no old family, and delete. Fixtures per the suite:
`shared`, `budget_repo`, `config_item_table`, `_with_table`, `table.item`, `table.update_calls`,
`table.put_calls`, `table.race_next_update()`, `table.always_race()`.
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


# --- [G1] XOR is a WRITE-guard invariant, not enforced by _unified_mirror ---

def test_unified_mirror_on_a_corrupt_both_families_entry_mirrors_both(shared):
    # A category has rollover XOR spread today, enforced by set_budget/set_spread stripping the
    # other family in the same write. _unified_mirror does NOT re-enforce it: a corrupt entry with
    # BOTH families derives BOTH mirrors, not one silently dropped. Pin this so a slice-3 reader
    # knows the mirror trusts the write guards for exclusivity (and a corrupt row shows up, loud).
    corrupt = {
        "target": Decimal(250), "rollover": True, "carryover": Decimal("50"),
        "carryover_from": "2026-07-01",
        "spread_amount": Decimal("1390.91"), "spread_cycles": Decimal(4),
        "spread_from": "2026-07-01", "spread_len": Decimal(14), "spread_paydate": "2026-07-01",
    }
    mirror = shared.budget._unified_mirror(corrupt)
    assert mirror["buffer"] == Decimal("50")               # rollover family mirrored
    assert mirror["payback_amount"] == Decimal("1390.91")  # AND spread family mirrored


# --- [G2] the dual-write mirror stays consistent across an optimistic-lock retry ---

def test_set_budget_rollover_buffer_mirror_survives_a_version_race(shared, budget_repo, config_item_table):
    # The competing writer bumps the version between our read and write; the retry re-derives the
    # mirror from the merged fields. It must be consistent (equal to carryover), never doubled or
    # dropped by the extra pass.
    table = config_item_table("BUDGETS", items={"groceries": {
        "target": Decimal(250), "rollover": True, "carryover": Decimal("50")}})
    table.race_next_update()
    _with_table(budget_repo, table)
    budget_repo.set_budget("groceries", Decimal(250), rollover=True,
        anchor={"carryover_from": "2026-07-01", "carryover_len": Decimal(14), "carryover_paydate": "2026-07-01"})
    entry = table.item["items"]["groceries"]
    assert table.update_calls == 2               # lost the lock once, converged on retry
    assert entry["buffer"] == Decimal("50")      # mirror consistent after the retry
    assert entry["buffer_from"] == "2026-07-01"
    assert entry["buffer_len"] == Decimal(14)


# --- [G3] backfill converges after a one-shot race; whole map intact ---

def test_backfill_converges_after_a_version_race(shared, budget_repo, config_item_table):
    table = config_item_table("BUDGETS", items={"groceries": {
        "target": Decimal(250), "rollover": True, "carryover": Decimal("50"),
        "carryover_from": "2026-07-01"}})
    table.race_next_update()
    _with_table(budget_repo, table)
    changed = budget_repo.backfill_unified()
    assert changed == 1
    assert table.update_calls == 2                                  # raced once, then converged
    assert table.item["items"]["groceries"]["buffer"] == Decimal("50")


# --- [G4] permanent contention -> raise, map NOT half-migrated ---

def test_backfill_raises_and_leaves_the_map_unmirrored_under_permanent_contention(shared, budget_repo, config_item_table):
    from repository_errors import VersionConflictError

    table = config_item_table("BUDGETS", items={"groceries": {
        "target": Decimal(250), "rollover": True, "carryover": Decimal("50")}})
    table.always_race()
    _with_table(budget_repo, table)
    with pytest.raises(VersionConflictError):
        budget_repo.backfill_unified()
    # every attempt failed the conditional write -> no mirror landed, map not half-written
    assert "buffer" not in table.item["items"]["groceries"]


# --- [G5] a MIXED map: rollover-only + spread-only + plain, mirrored in ONE write ---

def test_backfill_mixes_rollover_spread_and_plain_in_one_write(shared, budget_repo, config_item_table):
    table = config_item_table("BUDGETS", items={
        "groceries": {"target": Decimal(250), "rollover": True, "carryover": Decimal("50"),
                      "carryover_from": "2026-07-01"},
        "insurance": {"target": Decimal(250), "spread_amount": Decimal("1390.91"),
                      "spread_cycles": Decimal(4), "spread_from": "2026-07-01",
                      "spread_len": Decimal(14), "spread_paydate": "2026-07-01"},
        "coffee": {"target": Decimal(60)},
    })
    _with_table(budget_repo, table)
    changed = budget_repo.backfill_unified()
    assert changed == 2                 # the two smoothing entries; plain coffee unchanged
    assert table.update_calls == 1      # ONE whole-map write, not one per entry
    items = table.item["items"]
    assert items["groceries"]["buffer"] == Decimal("50")
    assert items["groceries"]["buffer_from"] == "2026-07-01"
    assert items["insurance"]["payback_amount"] == Decimal("1390.91")
    assert items["insurance"]["payback_cycles"] == Decimal(4)
    assert items["coffee"] == {"target": Decimal(60)}   # plain entry untouched, no mirror keys


# --- [G6] correct mirror + stale mirror in one map: only stale counted + orphan keys dropped ---

def test_backfill_rewrites_only_stale_mirrors_and_drops_orphan_mirror_keys(shared, budget_repo, config_item_table):
    table = config_item_table("BUDGETS", items={
        # already-correct mirror: buffer matches carryover, anchor matches -> unchanged
        "correct": {"target": Decimal(250), "rollover": True, "carryover": Decimal("50"),
                    "carryover_from": "2026-07-01", "buffer": Decimal("50"), "buffer_from": "2026-07-01"},
        # STALE: wrong buffer value + an orphan buffer_len whose carryover_len is gone
        "stale": {"target": Decimal(250), "rollover": True, "carryover": Decimal("50"),
                  "carryover_from": "2026-07-01", "buffer": Decimal("999"),
                  "buffer_from": "2020-01-01", "buffer_len": Decimal(99)},
    })
    _with_table(budget_repo, table)
    changed = budget_repo.backfill_unified()
    assert changed == 1                                 # only the stale entry differs
    fixed = table.item["items"]["stale"]
    assert fixed["buffer"] == Decimal("50")            # FAIL-ON-REVERT: corrected to match carryover
    assert fixed["buffer_from"] == "2026-07-01"        # anchor corrected
    assert "buffer_len" not in fixed                   # orphan mirror key dropped (no carryover_len)
    # the already-correct entry is byte-identical (still counted out of `changed`)
    assert table.item["items"]["correct"]["buffer"] == Decimal("50")


# --- [G7] an INCOMPLETE spread mirrors no payback (all-or-nothing), never KeyError ---

def test_incomplete_spread_mirrors_no_payback_and_does_not_crash(shared, budget_repo, config_item_table):
    incomplete = {"target": Decimal(250), "spread_amount": Decimal("1390.91"),
                  "spread_cycles": Decimal(4), "spread_from": "2026-07-01",
                  "spread_len": Decimal(14)}   # spread_paydate MISSING -> not a complete plan
    assert shared.budget._unified_mirror(incomplete) == {}   # no payback_* at all, no KeyError
    table = config_item_table("BUDGETS", items={"insurance": dict(incomplete)})
    _with_table(budget_repo, table)
    assert budget_repo.backfill_unified() == 0               # nothing to mirror -> no write
    assert table.update_calls == 0
    assert "payback_amount" not in table.item["items"]["insurance"]


# --- [G8]/[G9] clear strips an ORPHAN mirror even with no old family present ---

def test_clear_rollover_strips_an_orphan_buffer_mirror_with_no_old_family(shared, budget_repo, config_item_table):
    # A corrupt/legacy entry with the buffer mirror but no rollover/carryover: clear_rollover must
    # still strip the orphan mirror (buffer* is in the strip set), not treat it as a clean no-op.
    table = config_item_table("BUDGETS", items={"groceries": {
        "target": Decimal(250), "buffer": Decimal("50"), "buffer_from": "2026-07-01"}})
    _with_table(budget_repo, table)
    budget_repo.clear_rollover("groceries")
    assert table.item["items"]["groceries"] == {"target": Decimal(250)}   # orphan mirror gone
    assert table.update_calls == 1                                        # NOT a silent no-op


def test_clear_spread_strips_an_orphan_payback_mirror_with_no_old_family(shared, budget_repo, config_item_table):
    table = config_item_table("BUDGETS", items={"insurance": {
        "target": Decimal(250), "payback_amount": Decimal("1390.91"), "payback_cycles": Decimal(4)}})
    _with_table(budget_repo, table)
    budget_repo.clear_spread("insurance")
    assert table.item["items"]["insurance"] == {"target": Decimal(250)}
    assert table.update_calls == 1


# --- [G10] a plain re-write drops a stale orphan mirror key (strip-then-derive) ---

def test_set_budget_strips_a_stale_orphan_mirror_anchor_on_write(shared, budget_repo, config_item_table):
    # The entry carries a stale buffer_len whose carryover_len no longer exists. A plain amount edit
    # must drop the orphan mirror key: _with_mirror strips ALL mirror keys, then overlays only the
    # ones the current old fields derive. Without the strip, buffer_len would drift on forever.
    table = config_item_table("BUDGETS", items={"groceries": {
        "target": Decimal(250), "rollover": True, "carryover": Decimal("50"),
        "carryover_from": "2026-07-01",
        "buffer": Decimal("50"), "buffer_from": "2026-07-01", "buffer_len": Decimal(99),
    }})
    _with_table(budget_repo, table)
    budget_repo.set_budget("groceries", Decimal(300))   # plain amount edit, rollover untouched
    entry = table.item["items"]["groceries"]
    assert entry["target"] == Decimal(300)
    assert entry["buffer"] == Decimal("50")
    assert entry["buffer_from"] == "2026-07-01"
    assert "buffer_len" not in entry     # FAIL-ON-REVERT: orphan mirror key dropped (no carryover_len)


# --- [G11] delete drops the whole entry, mirror included ---

def test_delete_budget_drops_a_mirrored_entry_whole(shared, budget_repo, config_item_table):
    table = config_item_table("BUDGETS", items={
        "groceries": {"target": Decimal(250), "rollover": True, "carryover": Decimal("50"),
                      "buffer": Decimal("50"), "buffer_from": "2026-07-01"},
        "food": {"target": Decimal(80)}})
    _with_table(budget_repo, table)
    budget_repo.delete_budget("groceries")
    assert "groceries" not in table.item["items"]           # whole key gone, mirror included
    assert table.item["items"]["food"] == {"target": Decimal(80)}


# --- [G12] backfill on an absent config item: seed + no-op, no crash ---

def test_backfill_on_absent_config_item_seeds_and_is_a_noop(shared, budget_repo, config_item_table):
    table = config_item_table("BUDGETS", present=False)
    _with_table(budget_repo, table)
    assert budget_repo.backfill_unified() == 0   # nothing stored -> nothing to mirror
    assert table.update_calls == 0
    assert table.put_calls == 1                  # seeded the empty config item


# --- [G13] a negative carryover (deficit) mirrors to a negative buffer via backfill ---

def test_backfill_mirrors_a_negative_carryover_to_a_negative_buffer(shared, budget_repo, config_item_table):
    table = config_item_table("BUDGETS", items={"groceries": {
        "target": Decimal(250), "rollover": True, "carryover": Decimal("-1043.77"),
        "carryover_from": "2026-07-01"}})
    _with_table(budget_repo, table)
    assert budget_repo.backfill_unified() == 1
    assert table.item["items"]["groceries"]["buffer"] == Decimal("-1043.77")
