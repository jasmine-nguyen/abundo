"""WHIT-705: the one-off cleanup that removes stored $0.00 transactions.

Imports scripts/migrations/delete_zero_amount_transactions.py through importlib (like the
smooth->spread migration suites) and drives run(table, rows, dry_run) over an in-memory FakeTable.
`rows` stands in for the script's scan result.
"""

import importlib.util
import pathlib
from decimal import Decimal

from _dynamo_fakes import FakeTable

_MOD_PATH = (pathlib.Path(__file__).resolve().parents[2]
             / "scripts" / "migrations" / "delete_zero_amount_transactions.py")


def _load_script():
    spec = importlib.util.spec_from_file_location("delete_zero_amount_transactions", _MOD_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_PK = "ACCOUNT#westpac-altitude-black"


def _txn(txn_id, amount, **fields):
    return {"pk": _PK, "sk": f"TXN#{txn_id}", "transaction_id": txn_id,
            "account_id": "westpac-altitude-black", "date": "2026-09-27",
            "description": "FOREIGN FEE AUD 5.10", "amount": Decimal(amount), **fields}


def test_cleanup_deletes_only_zero_dollar_rows_and_only_when_applied():
    script = _load_script()
    table = FakeTable()
    fee = _txn("fee", "0")
    # A $0 row the user filed and noted is still removed (sign-off Q2).
    edited_fee = _txn("edited-fee", "0.00", category="travel", note="Wimbledon fee",
                      user_edited=True)
    # Scanned as $0, but the amount changed before the delete ran -> the condition skips it.
    changed = _txn("changed", "0")
    charge = _txn("charge", "-175.11", description="ANTHROPIC")
    table.seed(fee, edited_fee, {**changed, "amount": Decimal("-3.20")}, charge)
    scanned = [fee, edited_fee, changed]

    dry = script.run(table, scanned)

    assert dry == {"found": 3, "deleted": 0, "skipped": 0}
    assert len(table.store) == 4

    applied = script.run(table, scanned, dry_run=False)

    assert applied == {"found": 3, "deleted": 2, "skipped": 1}
    assert (_PK, "TXN#fee") not in table.store
    assert (_PK, "TXN#edited-fee") not in table.store
    assert table.store[(_PK, "TXN#changed")]["amount"] == Decimal("-3.20")
    assert table.store[(_PK, "TXN#charge")]["amount"] == Decimal("-175.11")

    again = script.run(table, [], dry_run=False)

    assert again == {"found": 0, "deleted": 0, "skipped": 0}
    assert len(table.store) == 2
