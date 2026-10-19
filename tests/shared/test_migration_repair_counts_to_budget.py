"""The one-off repair that recomputes each saved charge's counts_to_budget from its category (ABU-103).

Drives ``run(table, account_ids, dry_run)`` over the in-memory FakeTable, which applies the
script's real SET / condition expressions, so the checks read the stored rows back.
"""

import copy
from types import SimpleNamespace

import pytest

from _dynamo_fakes import FakeTable
from _migration_scripts import load_migration_script

_SPENDING = "up-spending"
_HOMELOAN = "up-homeloan"


def _txn(account_id, transaction_id, **fields):
    return {"pk": f"ACCOUNT#{account_id}", "sk": f"TXN#{transaction_id}",
            "transaction_id": transaction_id, "date": "2026-10-01", "status": "posted",
            "amount": "-12.50", **fields}


_REFILED = _txn(_SPENDING, "refiled", category="groceries", counts_to_budget=False)
_REFILED_PENDING = _txn(_SPENDING, "refiled-pending", status="pending", category="groceries",
                        counts_to_budget=False)
_UNFILED_TRANSFER = _txn(_SPENDING, "unfiled", category="TRANSFER_OUT", counts_to_budget=False)
_TRANSFER_IN = _txn(_SPENDING, "transfer-in", category="TRANSFER_IN", counts_to_budget=True)
_HOMELOAN_ROW = _txn(_HOMELOAN, "homeloan", category="groceries", counts_to_budget=False)
_EXCLUDED = _txn(_SPENDING, "excluded", category="groceries", counts_to_budget=False,
                 budget_excluded=True, notes="birthday", tags=["gift"])
_NO_CATEGORY = _txn(_SPENDING, "no-category", counts_to_budget=False)
_DELETED = {**_REFILED, "pk": f"DELETED#ACCOUNT#{_SPENDING}"}
_MARKER = {"pk": f"ACCOUNT#{_SPENDING}", "sk": "BANKSYNC#marker", "counts_to_budget": False}

_WRONG = {
    "refiled": True, "refiled-pending": True, "transfer-in": False, "excluded": True, "no-category": True,
}


def _key(row):
    return (row["pk"], row["sk"])


def _seeded_table():
    table = FakeTable()
    table.seed(*copy.deepcopy([
        _REFILED, _REFILED_PENDING, _UNFILED_TRANSFER, _TRANSFER_IN, _HOMELOAN_ROW, _EXCLUDED,
        _NO_CATEGORY, _DELETED, _MARKER,
    ]))
    return table


def _expected_store(before):
    after = copy.deepcopy(before)
    for transaction_id, value in _WRONG.items():
        after[(f"ACCOUNT#{_SPENDING}", f"TXN#{transaction_id}")]["counts_to_budget"] = value
    return after


@pytest.fixture
def script(shared):
    """Loaded under the `shared` fixture, so its shared/ imports are undone after each test."""
    return load_migration_script("repair_counts_to_budget")


def _account_ids(script):
    return list(script.ACCOUNT_ID_MAP.values())


@pytest.mark.parametrize("page_size", [None, 1])
def test_repair_fixes_only_wrong_rows_after_a_dry_run_and_is_safe_to_run_twice(script, page_size):
    table = _seeded_table()
    table.page_size = page_size
    before = copy.deepcopy(table.store)

    preview = script.run(table, _account_ids(script), dry_run=True)
    assert table.update_calls == []
    assert table.store == before
    assert preview == {"checked": 7, "found": 5, "repaired": 0, "skipped": 0}

    applied = script.run(table, _account_ids(script), dry_run=False)
    assert applied == {"checked": 7, "found": 5, "repaired": 5, "skipped": 0}
    assert table.store == _expected_store(before)

    writes = len(table.update_calls)
    rerun = script.run(table, _account_ids(script), dry_run=False)
    assert rerun == {"checked": 7, "found": 0, "repaired": 0, "skipped": 0}
    assert len(table.update_calls) == writes


def test_a_re_file_landing_mid_run_wins(script):
    table = FakeTable()
    table.seed(copy.deepcopy(_REFILED))

    def re_file(key, tbl):
        row = tbl.store[(key["pk"], key["sk"])]
        row["category"] = "TRANSFER_OUT"
        row["counts_to_budget"] = False

    table.before_next_write(re_file)
    result = script.run(table, [_SPENDING], dry_run=False)

    assert result == {"checked": 1, "found": 1, "repaired": 0, "skipped": 1}
    row = table.store[_key(_REFILED)]
    assert row["category"] == "TRANSFER_OUT"
    assert row["counts_to_budget"] is False


def test_a_row_deleted_mid_run_is_not_recreated(script):
    # [A6] The no-category write condition must refuse a row that's gone, never upsert a stub.
    table = FakeTable()
    table.seed(copy.deepcopy(_NO_CATEGORY))
    table.before_next_write(lambda key, tbl: tbl.store.pop((key["pk"], key["sk"])))

    result = script.run(table, [_SPENDING], dry_run=False)

    assert result == {"checked": 1, "found": 1, "repaired": 0, "skipped": 1}
    assert table.store == {}


@pytest.mark.parametrize("argv, writes", [([], False), (["--apply"], True)])
def test_main_saves_only_with_apply(script, monkeypatch, argv, writes):
    # [A7] The live command previews unless --apply is passed.
    table = _seeded_table()
    before = copy.deepcopy(table.store)
    monkeypatch.setattr(script.boto3, "resource", lambda *args, **kwargs: SimpleNamespace(Table=lambda name: table))
    monkeypatch.setattr(script.sys, "argv", ["repair_counts_to_budget.py", *argv])

    script.main()

    assert table.store == (_expected_store(before) if writes else before)
