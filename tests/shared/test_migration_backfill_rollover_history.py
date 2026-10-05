"""WHIT-742 slice 2: the one-off rebuild of past rollover cycles from saved transactions.

Imports scripts/migrations/backfill_rollover_history.py through importlib and drives
run(entries, categories, transactions, write, dry_run) on sample budgets. `entries` is the BUDGETS
item's per-category map; `write(category_id, history)` saves an entry's whole new
`carryover_history` and returns False when the conditional write lost to a change since the read.
"""

from decimal import Decimal

from _migration_scripts import load_migration_script

LENGTH = 14
ANCHOR = "2026-09-26"  # carryover_from: the first cycle not yet folded in
CYCLE_1 = ("2026-09-12", "2026-09-25")
CYCLE_2 = ("2026-08-29", "2026-09-11")
CYCLE_3 = ("2026-08-15", "2026-08-28")

CATEGORIES = [
    {"id": "utilities", "parent": None},
    {"id": "water", "parent": "utilities"},
    {"id": "fun", "parent": None},
]


def _charge(category, day, amount, status="posted"):
    return {"category": category, "date": day, "amount": Decimal(amount), "status": status,
            "counts_to_budget": True}


# Utilities at a $100 target: cycle 1 spent 620 (−520), cycle 2 spent 439 (−339), cycle 3 spent
# exactly 100 (0). Every older cycle has no spend, so each leaves +100.
TRANSACTIONS = [
    _charge("utilities", "2026-09-15", "-400"),
    _charge("water", "2026-09-20", "-220", status="pending"),
    _charge("utilities", "2026-09-01", "-439"),
    _charge("water", "2026-08-20", "-100"),
]


def _rebuilt(window, spent, leftover):
    return {"start": window[0], "end": window[1], "target": Decimal(100), "spent": Decimal(spent),
            "leftover": Decimal(leftover), "rebuilt": True}


def _utilities(carryover, **extra):
    return {"target": Decimal(100), "rollover": True, "carryover": Decimal(carryover),
            "carryover_from": ANCHOR, "carryover_len": LENGTH, **extra}


class _Writes:
    def __init__(self, succeeds=True):
        self.calls = []
        self.succeeds = succeeds

    def __call__(self, category_id, history):
        self.calls.append((category_id, history))
        return self.succeeds


def _run(entries, write, dry_run=False):
    script = load_migration_script("backfill_rollover_history")
    return script.run(entries, CATEGORIES, TRANSACTIONS, write, dry_run=dry_run)


def test_rebuild_saves_the_fewest_past_cycles_that_explain_the_carryover(shared):
    write = _Writes()
    entries = {
        # Exact: −520 + −339 == −859. Adding cycle 3 (0) ties, so the shorter list wins.
        "utilities": _utilities("-859"),
        # No spend and no target: no list of cycles beats showing nothing, so nothing is saved.
        "fun": {"target": Decimal(0), "rollover": True, "carryover": Decimal("-75"),
                "carryover_from": ANCHOR, "carryover_len": LENGTH},
        "groceries": {"target": Decimal(500), "rollover": False},
        "gifts": {**_utilities("0")},
        "phone": _utilities("-859", carryover_history=[_rebuilt(CYCLE_1, 620, -520)]),
    }

    result = _run(entries, write)

    assert write.calls == [("utilities", [_rebuilt(CYCLE_1, 620, -520), _rebuilt(CYCLE_2, 439, -339)])]
    assert result["rebuilt"] == 1


def test_when_no_cycles_add_up_exactly_the_closest_are_saved_and_the_gap_stays_unmatched(shared):
    write = _Writes()

    _run({"utilities": _utilities("-900")}, write)

    [(category_id, history)] = write.calls
    assert category_id == "utilities"
    assert history == [_rebuilt(CYCLE_1, 620, -520), _rebuilt(CYCLE_2, 439, -339)]
    assert Decimal("-900") - sum(record["leftover"] for record in history) == Decimal("-41")


def test_older_rebuilt_cycles_are_added_after_a_live_sealed_one_and_still_add_up(shared):
    live = {"start": CYCLE_1[0], "end": CYCLE_1[1], "target": Decimal(100), "spent": Decimal(620),
            "leftover": Decimal(-520)}
    write = _Writes()

    _run({"utilities": _utilities("-859", carryover_history=[live])}, write)

    [(_, history)] = write.calls
    assert history == [live, _rebuilt(CYCLE_2, 439, -339)]
    assert sum(record["leftover"] for record in history) == Decimal("-859")


def test_a_dry_run_saves_nothing(shared):
    write = _Writes()

    _run({"utilities": _utilities("-859")}, write, dry_run=True)

    assert write.calls == []


def test_a_budget_changed_since_the_read_is_skipped_not_overwritten(shared):
    write = _Writes(succeeds=False)

    result = _run({"utilities": _utilities("-859")}, write)

    assert len(write.calls) == 1
    assert result["rebuilt"] == 0
    assert result["skipped"] == 1
