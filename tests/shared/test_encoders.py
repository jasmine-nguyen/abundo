"""Unit tests for shared/encoders.py DecimalEncoder — the json.JSONEncoder that
lets DynamoDB's Decimal amounts serialise into the JSON API responses as numbers.
"""

import json
from decimal import Decimal


def _dumps(shared, value):
    return json.dumps(value, cls=shared.encoders.DecimalEncoder)


def test_decimal_serialises_as_json_number(shared):
    # A bare Decimal becomes a float in the output, not a quoted string.
    assert _dumps(shared, Decimal("12.34")) == "12.34"


def test_integer_valued_decimal_becomes_float(shared):
    # DynamoDB stores whole amounts as Decimal("10"); float() → 10.0, so the JSON
    # carries the decimal point.
    assert _dumps(shared, Decimal("10")) == "10.0"


def test_negative_decimal_preserved(shared):
    # Debit amounts are negative Decimals; the sign survives the float conversion.
    assert _dumps(shared, Decimal("-5.5")) == "-5.5"


def test_decimal_nested_in_structure(shared):
    # The encoder is applied recursively inside dicts/lists, matching how a
    # transaction row (Decimal amount) is serialised as part of a larger payload.
    payload = {"amount": Decimal("-12.00"), "tags": [Decimal("1"), Decimal("2.5")]}
    assert json.loads(_dumps(shared, payload)) == {
        "amount": -12.0,
        "tags": [1.0, 2.5],
    }


def test_native_json_types_pass_through_unchanged(shared):
    # Non-Decimal values are untouched — default() only intercepts Decimal, so
    # str/int/bool/None serialise via the base encoder.
    payload = {"s": "hi", "i": 3, "b": True, "n": None}
    assert json.loads(_dumps(shared, payload)) == payload


def test_unsupported_type_still_raises(shared):
    # default() delegates non-Decimal values to super(), so a genuinely
    # unserialisable object raises TypeError rather than being silently dropped.
    class Weird:
        pass

    try:
        _dumps(shared, Weird())
        assert False, "expected TypeError for an unserialisable object"
    except TypeError:
        pass
