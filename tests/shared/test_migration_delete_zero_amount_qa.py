"""WHIT-705 QA: edges of the one-off $0.00 cleanup script.

Loads scripts/migrations/delete_zero_amount_transactions.py through importlib and drives run() and
main() over the shared FakeTable.
"""

import sys
from decimal import Decimal

import pytest

from _dynamo_fakes import FakeTable, _client_error
from _migration_scripts import load_migration_script, use_fake_table

_PK = "ACCOUNT#westpac-altitude-black"


def _load_script():
    return load_migration_script("delete_zero_amount_transactions")


def _txn(txn_id, amount, pk=_PK, **fields):
    return {"pk": pk, "sk": f"TXN#{txn_id}", "transaction_id": txn_id,
            "account_id": pk.removeprefix("ACCOUNT#"), "date": "2026-09-27",
            "description": "FOREIGN FEE AUD 0.74", "amount": Decimal(amount), **fields}


# [A9]
def test_a_rerun_over_a_stale_scan_skips_rows_already_gone_and_deletes_nothing_else():
    script = _load_script()
    table = FakeTable()
    fee = _txn("fee", "0")
    charge = _txn("charge", "-25.73")
    table.seed(fee, charge)

    first = script.run(table, [fee], dry_run=False)
    second = script.run(table, [fee], dry_run=False)

    assert first == {"found": 1, "deleted": 1, "skipped": 0}
    assert second == {"found": 1, "deleted": 0, "skipped": 1}
    assert list(table.store) == [(_PK, "TXN#charge")]


# [A10]
def test_apply_writes_no_deleted_by_you_marker():
    script = _load_script()
    table = FakeTable()
    fee = _txn("fee", "0")
    table.seed(fee)

    script.run(table, [fee], dry_run=False)

    assert table.store == {}
    assert table.put_calls == []
    assert table.update_calls == []


# [A11]
def test_a_negative_zero_amount_is_still_deleted():
    script = _load_script()
    table = FakeTable()
    fee = _txn("fee", "-0.00")
    table.seed(fee)

    assert script.run(table, [fee], dry_run=False) == {"found": 1, "deleted": 1, "skipped": 0}
    assert table.store == {}


# [A12]
def test_a_non_condition_error_is_raised_not_counted_as_skipped():
    script = _load_script()
    table = FakeTable()
    fee = _txn("fee", "0")
    table.seed(fee)
    table.fail("delete_item")

    with pytest.raises(Exception) as excinfo:
        script.run(table, [fee], dry_run=False)

    assert excinfo.value.response["Error"]["Code"] == "ProvisionedThroughputExceededException"
    assert (_PK, "TXN#fee") in table.store


class _Cond:
    """Minimal boto3 Attr stand-in for main()'s scan filter: eq / begins_with, joined with &."""

    def __init__(self, fn):
        self.fn = fn

    def __and__(self, other):
        return _Cond(lambda item: self.fn(item) and other.fn(item))


class _Attr:
    def __init__(self, name):
        self.name = name

    def eq(self, value):
        return _Cond(lambda item: self.name in item and item[self.name] == value)

    def begins_with(self, prefix):
        return _Cond(lambda item: str(item.get(self.name, "")).startswith(prefix))


class _ScanTable(FakeTable):
    """FakeTable plus a paged scan: pages are cut BEFORE the filter, like DynamoDB's 1MB page."""

    def __init__(self, page_size):
        super().__init__()
        self.scan_page_size = page_size
        self.scan_calls = []

    def scan(self, FilterExpression, ExclusiveStartKey=None):
        self.scan_calls.append(ExclusiveStartKey)
        items = sorted(self.store.values(), key=lambda item: (item["pk"], item["sk"]))
        start = 0
        if ExclusiveStartKey is not None:
            keys = [(item["pk"], item["sk"]) for item in items]
            start = keys.index((ExclusiveStartKey["pk"], ExclusiveStartKey["sk"])) + 1
        page = items[start:start + self.scan_page_size]
        response = {"Items": [dict(item) for item in page if FilterExpression.fn(item)]}
        if start + self.scan_page_size < len(items):
            response["LastEvaluatedKey"] = {"pk": page[-1]["pk"], "sk": page[-1]["sk"]}
        return response


def _seed_main_table():
    table = _ScanTable(page_size=2)
    table.seed(
        _txn("a-charge", "-25.73"),
        _txn("b-charge", "-175.11"),
        _txn("c-fee", "0"),                      # behind a page the filter empties
        _txn("d-charge", "-1.00"),
        _txn("e-fee", "0.00", category="travel"),
        _txn("f-fee", "0", pk="ACCOUNT#anz-rewards-black-visa"),
        # Same zero amount, but not a transaction row: the scan must not touch these.
        {"pk": "DELETED#" + _PK, "sk": "TXN#gone", "amount": Decimal(0)},
        {"pk": "BUDGET", "sk": "TXN#not-a-txn", "amount": Decimal(0)},
        {"pk": _PK, "sk": "SNAPSHOT#1", "amount": Decimal(0)},
    )
    return table


def _run_main(monkeypatch, table, *argv):
    script = _load_script()
    monkeypatch.setattr(script, "Attr", _Attr)
    use_fake_table(monkeypatch, script, table)
    monkeypatch.setattr(sys, "argv", ["delete_zero_amount_transactions.py", *argv])
    script.main()


# [A13]
def test_main_is_a_dry_run_by_default(monkeypatch, capsys):
    table = _seed_main_table()
    before = dict(table.store)

    _run_main(monkeypatch, table)

    assert table.store == before
    out = capsys.readouterr().out
    assert "Dry run" in out
    assert "'found': 3" in out
    assert "'deleted': 0" in out


# [A14]
def test_main_apply_follows_every_scan_page_and_deletes_only_zero_transaction_rows(monkeypatch, capsys):
    table = _seed_main_table()

    _run_main(monkeypatch, table, "--apply")

    assert len(table.scan_calls) > 1
    remaining = {sk for _, sk in table.store}
    assert "TXN#c-fee" not in remaining
    assert "TXN#e-fee" not in remaining
    assert "TXN#f-fee" not in remaining
    assert {"TXN#a-charge", "TXN#b-charge", "TXN#d-charge"} <= remaining
    assert ("DELETED#" + _PK, "TXN#gone") in table.store
    assert ("BUDGET", "TXN#not-a-txn") in table.store
    assert (_PK, "SNAPSHOT#1") in table.store
    out = capsys.readouterr().out
    assert "Dry run" not in out
    assert "{'found': 3, 'deleted': 3, 'skipped': 0}" in out
