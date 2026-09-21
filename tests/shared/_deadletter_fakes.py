"""Shared readers for the dead-letter recovery suites' FakeTable store.

Two suites drive the dead-letter sweep against the FakeTable-backed `repo` fixture and
read the same two slices of its store: the FAILED# keys and the stored ACCOUNT#/TXN#
rows. They live here, in ONE definition, so both `import` them instead of each carrying
its own copy — the copies were already byte-identical (and the txn-rows reader had begun
to drift, differing only by name), so if the fake table's key scheme ever changed that
was three edits and a missed one fails confusingly (WHIT-494).

Consumers: tests/lambda/test_reprocess.py and tests/lambda/test_westpac_recovery_qa.py.

Resolved by pytest.ini's `pythonpath = tests/shared`, the same way the API suites import
`_feed_fakes`. This module is dependency-light (no imports), so it pulls no shared/-layer
module onto the path and needs no conftest `_REIMPORT` entry.
"""


def _failed_keys(repo):
    """The FAILED# dead-letter keys currently in the fake table's store."""
    return [k for k in repo._table.store if k[0] == "FAILED"]


def _txn_rows(repo):
    """Stored ACCOUNT#/TXN# rows as {sk: item} (account-id agnostic)."""
    return {k[1]: v for k, v in repo._table.store.items() if k[0].startswith("ACCOUNT#")}
