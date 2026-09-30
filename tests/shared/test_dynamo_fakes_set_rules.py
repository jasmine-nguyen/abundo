"""FakeTable's set rules (WHIT-636): DynamoDB refuses an empty set in ADD/DELETE, and (an app rule,
stricter than DynamoDB) the app stores only String Sets, so a set holding numbers is refused."""

import pytest
from botocore.exceptions import ClientError

from _dynamo_fakes import FakeTable


def _code(excinfo):
    return excinfo.value.response["Error"]["Code"]


def _update(table, key, action, marker):
    table.update_item(Key=key, UpdateExpression=f"{action} #f :m",
                      ExpressionAttributeNames={"#f": "fired"}, ExpressionAttributeValues={":m": marker})


def test_an_empty_set_in_add_or_delete_is_rejected_and_writes_nothing():
    table = FakeTable()
    table.seed({"pk": "N", "sk": "FIRED", "fired": {"a"}}, {"pk": "E", "sk": "EMPTY"})

    with pytest.raises(ClientError) as empty_add:
        _update(table, {"pk": "N", "sk": "FIRED"}, "ADD", set())
    with pytest.raises(ClientError) as empty_delete:
        _update(table, {"pk": "N", "sk": "FIRED"}, "DELETE", set())
    with pytest.raises(ClientError) as empty_delete_missing_attribute:
        _update(table, {"pk": "E", "sk": "EMPTY"}, "DELETE", set())
    with pytest.raises(ClientError) as empty_delete_missing_row:
        _update(table, {"pk": "M", "sk": "MISSING"}, "DELETE", set())

    assert _code(empty_add) == "ValidationException"
    assert _code(empty_delete) == "ValidationException"
    assert _code(empty_delete_missing_attribute) == "ValidationException"
    assert _code(empty_delete_missing_row) == "ValidationException"
    assert table.get_item(Key={"pk": "N", "sk": "FIRED"})["Item"]["fired"] == {"a"}
    assert table.get_item(Key={"pk": "E", "sk": "EMPTY"})["Item"] == {"pk": "E", "sk": "EMPTY"}
    assert table.get_item(Key={"pk": "M", "sk": "MISSING"}) == {}


def test_a_first_add_of_a_number_set_is_rejected_and_creates_no_row():
    table = FakeTable()

    with pytest.raises(ClientError) as number_set:
        _update(table, {"pk": "N", "sk": "FIRED"}, "ADD", {1})

    assert _code(number_set) == "ValidationException"
    assert table.get_item(Key={"pk": "N", "sk": "FIRED"}) == {}
