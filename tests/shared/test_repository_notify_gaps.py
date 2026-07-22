"""WHIT-316 QA gap test: `last_repayment_fired_at()` must return a plain int even when
DynamoDB hands the stored timestamp back as a boto3 Decimal.

Numbers read from real DynamoDB come back as `decimal.Decimal`, never `int` — the fake
table in the implementer's round-trip test stores the python int that `mark_repayment_fired`
wrote, so it never exercises the `int(last_fired_at)` cast. The balance poller then compares
this value to an int cutoff; a stray Decimal would still compare, but the contract is int.
"""

from decimal import Decimal

_KEY = ("NOTIFY#REPAYMENT", "FIRED")


class _DecimalTable:
    """Returns the last_fired_at as a boto3-style Decimal, the way DynamoDB really does."""

    def __init__(self, stored):
        self._item = {"pk": _KEY[0], "sk": _KEY[1], "last_fired_at": stored}

    def get_item(self, Key):
        return {"Item": dict(self._item)}


def test_last_fired_at_decimal_from_dynamo_returns_int(shared):
    r = shared.notify.NotifyRepository()
    r._table = _DecimalTable(Decimal("1752000000"))
    result = r.last_repayment_fired_at()
    assert result == 1752000000
    assert type(result) is int  # not Decimal -> the int() cast is load-bearing
