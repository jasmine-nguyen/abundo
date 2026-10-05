"""Sample charges and cycle records for the rollover-history suites (WHIT-742).

Resolved by pytest.ini's `pythonpath = tests/shared`.
"""

from decimal import Decimal


def charge(category, day, amount, status="posted"):
    """One stored transaction that counts toward a budget."""
    return {"category": category, "date": day, "amount": Decimal(amount), "status": status,
            "counts_to_budget": True}


def cycle_record(start, end, spent, leftover, **extra):
    """One saved cycle of a $100-target rollover budget, plus any flags (e.g. rebuilt=True)."""
    return {"start": start, "end": end, "target": Decimal(100), "spent": Decimal(spent),
            "leftover": Decimal(leftover), **extra}
