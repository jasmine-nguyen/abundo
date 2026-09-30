"""WHIT-676 QA: the empty-set rule's edges — sets nested in lists, and empty sets in condition values.

DynamoDB checks every attribute value before it evaluates a condition, so an empty set is refused
with ValidationException (never ConditionalCheckFailedException) and nothing is written.
"""

import pytest
from botocore.exceptions import ClientError

from _dynamo_fakes import FakeTable, error_code


def test_an_empty_set_inside_a_list_is_rejected_by_put_and_set():
    # [A1]
    table = FakeTable()
    with pytest.raises(ClientError) as refused:
        table.put_item(Item={"pk": "L", "sk": "PUT", "items": [{"tags": set()}]})
    assert error_code(refused) == "ValidationException"
    assert table.get_item(Key={"pk": "L", "sk": "PUT"}) == {}

    seeded = {"pk": "L", "sk": "SET", "items": ["a"]}
    table.seed(dict(seeded))
    with pytest.raises(ClientError) as refused:
        table.update_item(Key={"pk": "L", "sk": "SET"}, UpdateExpression="SET #i = :v",
                          ExpressionAttributeNames={"#i": "items"},
                          ExpressionAttributeValues={":v": ["b", set()]})
    assert error_code(refused) == "ValidationException"
    assert table.get_item(Key={"pk": "L", "sk": "SET"})["Item"] == seeded


def test_an_empty_set_in_a_put_condition_value_is_refused_before_the_condition():
    # [A2] critic tweak: put_item checks ExpressionAttributeValues too
    table = FakeTable()
    existing = {"pk": "C", "sk": "PUT", "state": "old"}
    table.seed(dict(existing))
    with pytest.raises(ClientError) as refused:
        table.put_item(Item={"pk": "C", "sk": "PUT", "state": "new"},
                       ConditionExpression="#s = :v",
                       ExpressionAttributeNames={"#s": "state"},
                       ExpressionAttributeValues={":v": set()})
    assert error_code(refused) == "ValidationException"
    assert table.get_item(Key={"pk": "C", "sk": "PUT"})["Item"] == existing


def test_an_empty_set_in_an_update_condition_value_is_refused_before_the_condition():
    # [A3] every expression value is checked upfront, condition values included
    table = FakeTable()
    existing = {"pk": "C", "sk": "UPD", "state": "old"}
    table.seed(dict(existing))
    with pytest.raises(ClientError) as refused:
        table.update_item(Key={"pk": "C", "sk": "UPD"}, UpdateExpression="SET #s = :new",
                          ConditionExpression="#s = :v",
                          ExpressionAttributeNames={"#s": "state"},
                          ExpressionAttributeValues={":new": "new", ":v": set()})
    assert error_code(refused) == "ValidationException"
    assert table.get_item(Key={"pk": "C", "sk": "UPD"})["Item"] == existing


def test_a_non_empty_set_is_still_written_by_set_put_and_batch():
    # [A4] regression: the rule must not refuse real sets
    table = FakeTable()
    table.put_item(Item={"pk": "K", "sk": "PUT", "fired": {"a"}, "m": {"s": {"b"}}})
    with table.batch_writer() as batch:
        batch.put_item(Item={"pk": "K", "sk": "BATCH", "fired": {"c"}})
    table.update_item(Key={"pk": "K", "sk": "PUT"}, UpdateExpression="SET #f = :v",
                      ExpressionAttributeNames={"#f": "fired"}, ExpressionAttributeValues={":v": {"d"}})
    assert table.get_item(Key={"pk": "K", "sk": "PUT"})["Item"]["fired"] == {"d"}
    assert table.get_item(Key={"pk": "K", "sk": "PUT"})["Item"]["m"] == {"s": {"b"}}
    assert table.get_item(Key={"pk": "K", "sk": "BATCH"})["Item"]["fired"] == {"c"}
