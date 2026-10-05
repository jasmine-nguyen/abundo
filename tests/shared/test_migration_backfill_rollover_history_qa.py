"""WHIT-742 QA: edges of the one-off rebuild of past rollover cycles.

Drives run() on its own, and main() over the shared FakeTable (the BUDGETS item as DynamoDB stores
it: Decimal numbers, a `version`), then feeds the saved entry back through budget_standing to check
the budget page's list still adds up to the carryover.
"""

import sys
from datetime import date
from decimal import Decimal

import pytest

from _dynamo_fakes import FakeTable, _client_error
from _migration_scripts import load_migration_script, use_fake_table
from _rollover_fakes import charge, cycle_record
from test_budget_standing import budget_standing  # noqa: F401 — the fixture
from test_migration_backfill_rollover_history import (
    ANCHOR,
    CATEGORIES,
    CYCLE_1,
    CYCLE_2,
    LENGTH,
    TRANSACTIONS,
    _utilities,
    _Writes,
)

_KEY = {"pk": "BUDGETS", "sk": "BUDGETS"}
PAYDATE = "2026-01-03"  # a payday 14-day-aligned with ANCHOR


def _load_script():
    return load_migration_script("backfill_rollover_history")


def _stored(carryover, **extra):
    """A rollover entry exactly as DynamoDB hands it back: every number a Decimal."""
    return {**_utilities(carryover, **extra), "carryover_len": Decimal(LENGTH),
            "carryover_paydate": PAYDATE}


def _seed(entries, version=7):
    table = FakeTable()
    table.seed({**_KEY, "items": entries, "version": Decimal(version)})
    return table


class _Categories:
    def list_categories(self):
        return CATEGORIES


def _run_main(monkeypatch, table, *argv, transactions=TRANSACTIONS):
    script = _load_script()
    reads = []

    def read_window(repo, start, end):
        reads.append((start, end))
        return transactions

    use_fake_table(monkeypatch, script, table)
    monkeypatch.setattr(script, "read_window", read_window)
    monkeypatch.setattr(script, "TransactionRepository", lambda: None)
    monkeypatch.setattr(script, "CategoryRepository", _Categories)
    monkeypatch.setattr(sys, "argv", ["backfill_rollover_history.py", *argv])
    script.main()
    return reads


def _item(table):
    return table.store[("BUDGETS", "BUDGETS")]


# [A1]
def test_main_is_a_dry_run_by_default_and_saves_nothing(monkeypatch, capsys, shared):
    table = _seed({"utilities": _stored("-859")})
    before = _item(table)

    _run_main(monkeypatch, table)

    assert table.update_calls == []
    assert _item(table) == before
    out = capsys.readouterr().out
    assert "Dry run" in out
    assert "-520" in out and "-339" in out


# [A2]
def test_main_apply_saves_the_rebuilt_list_bumps_the_version_and_keeps_every_other_field(
        monkeypatch, capsys, shared):
    groceries = {"target": Decimal(500)}
    table = _seed({"utilities": _stored("-859"), "groceries": groceries})

    _run_main(monkeypatch, table, "--apply")

    item = _item(table)
    assert item["version"] == Decimal(8)
    assert item["items"]["groceries"] == groceries
    assert item["items"]["utilities"] == {
        **_stored("-859"),
        "carryover_history": [cycle_record(*CYCLE_1, 620, -520, rebuilt=True), cycle_record(*CYCLE_2, 439, -339, rebuilt=True)],
    }
    assert "{'rebuilt': 1, 'skipped': 0}" in capsys.readouterr().out


# [A3]
def test_main_apply_twice_changes_nothing_the_second_time_even_if_transactions_moved(monkeypatch, shared):
    table = _seed({"utilities": _stored("-900")})  # a −41 gap stays unmatched after run 1
    _run_main(monkeypatch, table, "--apply")
    after_first = _item(table)
    writes = len(table.update_calls)
    # A late charge now makes the next-older cycle explain the −41 exactly; a rebuilt budget is
    # still never rebuilt again.
    late = [charge("utilities", "2026-08-20", "-41")]

    _run_main(monkeypatch, table, "--apply", transactions=TRANSACTIONS + late)

    assert len(table.update_calls) == writes
    assert _item(table) == after_first


# [A4]
def test_main_apply_saves_every_budget_in_one_run_tracking_its_own_version_bumps(monkeypatch, capsys, shared):
    table = _seed({"utilities": _stored("-859"), "fun": _stored("200")})

    _run_main(monkeypatch, table, "--apply")

    item = _item(table)
    assert item["version"] == Decimal(9)
    assert item["items"]["utilities"]["carryover_history"] == [
        cycle_record(*CYCLE_1, 620, -520, rebuilt=True), cycle_record(*CYCLE_2, 439, -339, rebuilt=True)]
    assert item["items"]["fun"]["carryover_history"] == [cycle_record(*CYCLE_1, 0, 100, rebuilt=True), cycle_record(*CYCLE_2, 0, 100, rebuilt=True)]
    assert "{'rebuilt': 2, 'skipped': 0}" in capsys.readouterr().out


# [A5]
def test_main_apply_skips_a_budget_a_live_seal_changed_after_the_read(monkeypatch, capsys, shared):
    table = _seed({"utilities": _stored("-859")})

    def live_seal(key, table_):
        # The app seals a cycle between the script's read and its write.
        live_item = table_.store[("BUDGETS", "BUDGETS")]
        live_item["items"]["utilities"]["carryover_history"] = [{"start": ANCHOR, "leftover": Decimal(5)}]
        live_item["version"] += 1

    table.before_next_write(live_seal)

    _run_main(monkeypatch, table, "--apply")

    assert _item(table)["items"]["utilities"]["carryover_history"] == [
        {"start": ANCHOR, "leftover": Decimal(5)}]
    assert "{'rebuilt': 0, 'skipped': 1}" in capsys.readouterr().out


# [A6]
def test_main_apply_raises_a_write_error_that_is_not_a_lost_race(monkeypatch, shared):
    table = _seed({"utilities": _stored("-859")})
    table.fail("update_item")

    with pytest.raises(Exception) as excinfo:
        _run_main(monkeypatch, table, "--apply")

    assert excinfo.value.response["Error"]["Code"] == "ProvisionedThroughputExceededException"
    assert "carryover_history" not in _item(table)["items"]["utilities"]


# [A7]
def test_main_reads_transactions_over_every_cycle_it_may_walk_back_and_nothing_newer(monkeypatch, shared):
    live = cycle_record(*CYCLE_1, 620, -520)
    table = _seed({"utilities": _stored("-859"), "phone": _stored("-859", carryover_history=[live])})

    reads = _run_main(monkeypatch, table)

    # phone walks back 26 cycles from its oldest saved start (2026-09-12); utilities stops at the
    # day before its anchor.
    assert reads == [("2025-09-13", "2026-09-25")]


# [A8]
def test_main_with_no_budgets_item_reads_and_writes_nothing(monkeypatch, capsys, shared):
    table = FakeTable()

    reads = _run_main(monkeypatch, table, "--apply")

    assert reads == []
    assert table.update_calls == []
    assert "nothing to rebuild" in capsys.readouterr().out


def _run(entries, transactions=TRANSACTIONS, categories=CATEGORIES):
    write = _Writes()
    result = _load_script().run(entries, categories, transactions, write, dry_run=False)
    return write.calls, result


def _sealed(n):
    # Placeholder live records whose oldest start is the anchor, so the walk starts at CYCLE_1.
    return {"start": ANCHOR, "end": f"2026-10-{n:02d}", "target": Decimal(100),
            "spent": Decimal(0), "leftover": Decimal(0)}


# [A9]
def test_the_saved_list_never_grows_past_the_history_cap(shared):
    full = [_sealed(n) for n in range(1, 27)]
    almost = [_sealed(n) for n in range(1, 26)]

    full_calls, _ = _run({"utilities": _stored("-859", carryover_history=full)})
    almost_calls, _ = _run({"utilities": _stored("-859", carryover_history=almost)})

    assert full_calls == []
    # Two cycles would match −859 exactly, but only one fits under the cap.
    assert [history[25:] for _, history in almost_calls] == [[cycle_record(*CYCLE_1, 620, -520, rebuilt=True)]]


# [A10]
def test_a_history_that_already_explains_the_carryover_is_left_alone(shared):
    live = [{key: value for key, value in record.items() if key != "rebuilt"}
            for record in (cycle_record(*CYCLE_1, 620, -520, rebuilt=True), cycle_record(*CYCLE_2, 439, -339, rebuilt=True))]

    calls, result = _run({"utilities": _stored("-859", carryover_history=live)})

    assert calls == []
    assert result == {"rebuilt": 0, "skipped": 0}


# [A11]
def test_leftovers_rebuild_as_positive_cycles(shared):
    calls, _ = _run({"fun": {**_stored("200"), "target": Decimal(100)}},
                    categories=[{"id": "fun", "parent": None}])

    assert calls == [("fun", [
        {**cycle_record(*CYCLE_1, 0, 100, rebuilt=True)},
        {**cycle_record(*CYCLE_2, 0, 100, rebuilt=True)},
    ])]


# [A12]
def test_spend_on_or_after_the_anchor_never_lands_in_a_rebuilt_cycle(shared):
    current_cycle = [charge("utilities", ANCHOR, "-5000")]

    calls, _ = _run({"utilities": _stored("-859")}, transactions=TRANSACTIONS + current_cycle)

    assert calls == [("utilities", [cycle_record(*CYCLE_1, 620, -520, rebuilt=True), cycle_record(*CYCLE_2, 439, -339, rebuilt=True)])]


# [A13]
def test_charges_the_live_seal_ignores_are_ignored_by_the_rebuild_too(shared):
    ignored = [
        {**charge("utilities", "2026-09-14", "-999"), "budget_excluded": True},
        {**charge("utilities", "2026-09-14", "-999"), "counts_to_budget": False},
        charge("payslip", "2026-09-14", "-999"),  # an Income child filed under Utilities
    ]
    categories = CATEGORIES + [{"id": "payslip", "parent": "utilities", "bucket": "Income"}]
    categories = [{**category, "bucket": category.get("bucket", "Spending")} for category in categories]

    calls, _ = _run({"utilities": _stored("-859")}, transactions=TRANSACTIONS + ignored,
                    categories=categories)

    assert calls == [("utilities", [cycle_record(*CYCLE_1, 620, -520, rebuilt=True), cycle_record(*CYCLE_2, 439, -339, rebuilt=True)])]


# [A14]
def test_after_the_rebuild_the_budget_page_list_adds_up_and_the_numbers_do_not_move(budget_standing):  # noqa: F811
    write = _Writes()
    entry = _stored("-900")
    window = budget_standing.standing_window(
        {"utilities": entry}, {"length": LENGTH, "last_pay_date": PAYDATE}, today=date(2026, 9, 30))
    assert window.cycle_start == ANCHOR
    before, _ = budget_standing.budget_standing({"utilities": entry}, window, CATEGORIES, [])

    _load_script().run({"utilities": entry}, CATEGORIES, TRANSACTIONS, write, dry_run=False)
    [(_, history)] = write.calls
    rows, settlements = budget_standing.budget_standing(
        {"utilities": {**entry, "carryover_history": history}}, window, CATEGORIES, [])

    row = rows["utilities"]
    assert row["carryover"] == before["utilities"]["carryover"] == Decimal(-900)
    assert row["available"] == before["utilities"]["available"]
    assert [cycle["rebuilt"] for cycle in row["carryover_cycles"]] == [True, True]
    assert row["carryover_earlier"] == Decimal(-41)
    assert sum(c["leftover"] for c in row["carryover_cycles"]) + row["carryover_earlier"] == row["carryover"]
    assert settlements["rollover"] == {}


# [A15]
def test_a_cycle_sealed_after_the_rebuild_goes_in_front_and_the_list_still_adds_up(budget_standing):  # noqa: F811
    write = _Writes()
    entry = _stored("-900")
    _load_script().run({"utilities": entry}, CATEGORIES, TRANSACTIONS, write, dry_run=False)
    [(_, history)] = write.calls
    targets = {"utilities": {**entry, "carryover_history": history}}
    # Three and a half weeks on: the 26 Sep – 9 Oct cycle is past the settle lag, so it seals.
    window = budget_standing.standing_window(
        targets, {"length": LENGTH, "last_pay_date": PAYDATE}, today=date(2026, 10, 20))
    charges = [charge("utilities", "2026-10-01", "-130")]

    rows, settlements = budget_standing.budget_standing(targets, window, CATEGORIES, charges)

    row = rows["utilities"]
    assert row["carryover"] == Decimal(-930)
    assert [(c["start"], c.get("rebuilt", False)) for c in row["carryover_cycles"]] == [
        ("2026-09-26", False), (CYCLE_1[0], True), (CYCLE_2[0], True)]
    assert sum(c["leftover"] for c in row["carryover_cycles"]) + row["carryover_earlier"] == Decimal(-930)
    saved = settlements["rollover"]["utilities"]["carryover_history"]
    assert [record.get("rebuilt", False) for record in saved] == [False, True, True]
