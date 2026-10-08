"""Shared pay-cycle wiring for test_paycycle.py and test_paycycle_parity.py.

``paycycle_repo`` builds the REAL PayCycleRepository over a FakeTable (WHIT-625), so the seed,
the version lock and the retry run as production wrote them. ``stored_cycle`` reads back what the
table holds.

Resolved by pytest.ini's `pythonpath = tests/shared`. The shared layer is imported lazily, inside
``paycycle_repo``, so under the ``handler`` fixture it is the same copy the handler uses.
"""

from decimal import Decimal

from _dynamo_fakes import FakeTable

_PAYCYCLE_KEY = ("PAYCYCLE", "PAYCYCLE")


def paycycle_repo(cycle=None):
    """``(table, PayCycleRepository)``. ``cycle`` ({"length", "last_pay_date"}) is stored as the
    saved pay cycle; None leaves the table empty, so the repository seeds its own default."""
    from repository_paycycle import PayCycleRepository

    table = FakeTable()
    if cycle is not None:
        table.seed({"pk": "PAYCYCLE", "sk": "PAYCYCLE", "length": Decimal(cycle["length"]),
                    "last_pay_date": cycle["last_pay_date"], "version": Decimal(1)})
    repo = PayCycleRepository()
    repo._table = table
    return table, repo


def stored_cycle(table):
    """The saved ``(length, last_pay_date)``, or None if nothing is stored."""
    item = table.store.get(_PAYCYCLE_KEY)
    if item is None:
        return None
    return int(item["length"]), item["last_pay_date"]
