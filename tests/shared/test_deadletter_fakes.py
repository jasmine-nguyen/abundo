"""WHIT-494 — pins the CONTRACT of the consolidated dead-letter store readers.

The two big suites (test_reprocess / test_westpac_recovery_qa) exercise
`_failed_keys` / `_txn_rows` only THROUGH the real webhook repository + handler
machinery. These focused tests pin the readers' slicing/keying contract directly
against a crafted `repo._table.store`, so the shared behaviour stays locked even
if those suites change, and a subtle drift (wrong predicate, keying by pk instead
of sk) reddens here without needing the whole lambda import chain.

Imports the REAL production readers (no re-implementation) — the crafted repo is
only the INPUT, mirroring FakeTable.store's `(pk, sk) -> item` layout
(tests/lambda/conftest.py) and the real pk shapes: dead letters live under
pk="FAILED" (shared/repository_transaction.py), txns under pk="ACCOUNT#<id>",
sk="TXN#<id>".
"""

from types import SimpleNamespace

from _deadletter_fakes import _failed_keys, _txn_rows


def _repo(store):
    """A stand-in exposing only what the readers touch: repo._table.store."""
    return SimpleNamespace(_table=SimpleNamespace(store=store))


def _store():
    """A store mixing FAILED dead letters and ACCOUNT#/TXN# rows for one account."""
    return {
        ("FAILED", "r1"): {"pk": "FAILED", "sk": "r1", "raw": "{}"},
        ("FAILED", "r2"): {"pk": "FAILED", "sk": "r2", "raw": "{}"},
        ("ACCOUNT#A", "TXN#t1"): {"pk": "ACCOUNT#A", "sk": "TXN#t1", "status": "posted"},
        ("ACCOUNT#A", "TXN#t2"): {"pk": "ACCOUNT#A", "sk": "TXN#t2", "status": "pending"},
    }


# --- _failed_keys ---------------------------------------------------------

def test_failed_keys_returns_only_failed_partition_as_full_keys():
    # [A5] returns exactly the pk=="FAILED" composite keys, nothing from ACCOUNT#.
    keys = _failed_keys(_repo(_store()))
    assert sorted(keys) == [("FAILED", "r1"), ("FAILED", "r2")]


def test_failed_keys_is_exact_match_not_prefix():
    # [A6] predicate is `== "FAILED"`, so a lookalike partition is NOT swept.
    store = {
        ("FAILED", "r1"): {"pk": "FAILED", "sk": "r1"},
        ("FAILED#X", "r2"): {"pk": "FAILED#X", "sk": "r2"},  # not a dead letter
    }
    assert _failed_keys(_repo(store)) == [("FAILED", "r1")]


def test_failed_keys_empty_when_no_dead_letters():
    # [A7] empty backlog -> empty list (the post-reprocess "all recovered" assert).
    store = {("ACCOUNT#A", "TXN#t1"): {"pk": "ACCOUNT#A", "sk": "TXN#t1"}}
    assert _failed_keys(_repo(store)) == []


# --- _txn_rows ------------------------------------------------------------

def test_txn_rows_keys_by_sort_key_not_partition():
    # [A8] result is {sk: item} — keyed by k[1] (TXN#...), NOT the ACCOUNT# pk.
    rows = _txn_rows(_repo(_store()))
    assert set(rows) == {"TXN#t1", "TXN#t2"}
    assert rows["TXN#t1"]["status"] == "posted"
    assert rows["TXN#t2"]["status"] == "pending"


def test_txn_rows_excludes_failed_partition():
    # [A9] FAILED rows never leak into the txn-rows view.
    rows = _txn_rows(_repo(_store()))
    assert all(not sk.startswith("r") for sk in rows)  # no FAILED sks (r1/r2)
    assert "r1" not in rows and "r2" not in rows


def test_txn_rows_is_account_id_agnostic_and_collapses_same_sk():
    # [A10] pins the documented "account-id agnostic" keying: two DIFFERENT accounts
    # holding the same sk collapse to one entry (last-in wins). This is the shape the
    # readers guarantee; if keying ever changed to (pk,sk) this would stop collapsing.
    store = {
        ("ACCOUNT#A", "TXN#dup"): {"pk": "ACCOUNT#A", "sk": "TXN#dup", "who": "A"},
        ("ACCOUNT#B", "TXN#dup"): {"pk": "ACCOUNT#B", "sk": "TXN#dup", "who": "B"},
    }
    rows = _txn_rows(_repo(store))
    assert list(rows) == ["TXN#dup"]
    assert rows["TXN#dup"]["who"] in {"A", "B"}
