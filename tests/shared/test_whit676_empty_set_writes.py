"""WHIT-676: FakeTable refuses an empty set written through SET, put_item and the batch writer.

DynamoDB rejects an empty set anywhere in a written value (nested ones included) with a
ValidationException, and the write changes nothing.
"""

import pytest
from botocore.exceptions import ClientError

from _dynamo_fakes import FakeTable, error_code


def _set_field(table, key, value):
    table.update_item(Key=key, UpdateExpression="SET #f = :m",
                      ExpressionAttributeNames={"#f": "fired"}, ExpressionAttributeValues={":m": value})


def test_an_empty_set_written_by_set_is_rejected_and_writes_nothing():
    table = FakeTable()
    seeded = {"pk": "N", "sk": "FIRED", "fired": {"a"}, "expires": 1}
    table.seed(dict(seeded))

    for value in (set(), {"inner": set()}):
        with pytest.raises(ClientError) as refused:
            _set_field(table, {"pk": "N", "sk": "FIRED"}, value)
        assert error_code(refused) == "ValidationException"
        assert table.get_item(Key={"pk": "N", "sk": "FIRED"})["Item"] == seeded

    with pytest.raises(ClientError) as refused:
        _set_field(table, {"pk": "N", "sk": "MISSING"}, set())
    assert error_code(refused) == "ValidationException"
    assert table.get_item(Key={"pk": "N", "sk": "MISSING"}) == {}


def test_an_empty_set_in_a_saved_row_is_rejected_and_saves_nothing():
    table = FakeTable()

    for item in ({"pk": "P", "sk": "TOP", "fired": set()},
                 {"pk": "P", "sk": "NESTED", "m": {"s": set()}}):
        with pytest.raises(ClientError) as refused:
            table.put_item(Item=item)
        assert error_code(refused) == "ValidationException"
        assert table.get_item(Key={"pk": item["pk"], "sk": item["sk"]}) == {}

    with pytest.raises(ClientError) as refused:
        with table.batch_writer() as batch:
            batch.put_item(Item={"pk": "B", "sk": "TOP", "fired": set()})
    assert error_code(refused) == "ValidationException"
    assert table.get_item(Key={"pk": "B", "sk": "TOP"}) == {}

    existing = {"pk": "P", "sk": "OLD", "fired": {"a"}}
    table.seed(dict(existing))
    with pytest.raises(ClientError) as refused:
        table.put_item(Item={"pk": "P", "sk": "OLD", "fired": set()})
    assert error_code(refused) == "ValidationException"
    assert table.get_item(Key={"pk": "P", "sk": "OLD"})["Item"] == existing
