"""The REAL AccountBalanceRepository over a FakeTable for the balance-refresh suites (WHIT-625).

The refresh throttle marker and the stored balances are production's rows, so a later read sees
what an earlier write really stored. ``balance_writes`` reads the table's put log in order.

Resolved by pytest.ini's `pythonpath = tests/shared`. The shared layer is imported lazily, inside
``balance_repo``, so inside a ``handler``-style fixture it comes from the freshly loaded copy.
"""

from _dynamo_fakes import FakeTable

_MARKER_PK = "ACCTBAL#REFRESH"
_BALANCE_PREFIX = "ACCTBAL#"


def balance_repo(rows=(), last=None):
    """The real AccountBalanceRepository holding ``rows`` (list_balances-shaped dicts, stored
    through the real upsert_balance) and, when ``last`` is given, a refresh marker at that epoch.
    The put log is cleared after that setup, so ``balance_writes`` shows only the code under test."""
    from repository import AccountBalanceRepository

    repo = AccountBalanceRepository()
    repo._table = FakeTable()
    for row in rows:
        repo.upsert_balance(row["account_id"], row["amount"], row["available_balance"],
                            row["currency"], row["as_of"], row["account_type"])
    if last is not None:
        repo.set_last_refresh_at(last)
    repo._table.put_calls.clear()
    return repo


def balance_writes(repo):
    """Each write in order: ("set", epoch) for the refresh marker, ("upsert", account_id) for a
    stored balance."""
    writes = []
    for item in repo._table.put_calls:
        if item["pk"] == _MARKER_PK:
            writes.append(("set", item["last_fetch_at"]))
        else:
            writes.append(("upsert", item["pk"][len(_BALANCE_PREFIX):]))
    return writes


def marker_writes(repo):
    """The epoch of each refresh-marker write, in order."""
    return [at for kind, at in balance_writes(repo) if kind == "set"]


def upserted(repo):
    """{account_id: amount} of every balance the code stored."""
    return {item["pk"][len(_BALANCE_PREFIX):]: item["amount"]
            for item in repo._table.put_calls if item["pk"] != _MARKER_PK}
