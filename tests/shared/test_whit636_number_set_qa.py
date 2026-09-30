"""WHIT-636 QA: the app-only number-set rule on the paths the build's tests leave open."""

import pytest
from botocore.exceptions import ClientError

from _dynamo_fakes import FakeTable


def _code(excinfo):
    return excinfo.value.response["Error"]["Code"]


def _update(table, key, action, marker):
    table.update_item(Key=key, UpdateExpression=f"{action} #f :m",
                      ExpressionAttributeNames={"#f": "fired"}, ExpressionAttributeValues={":m": marker})


def test_a_number_set_is_refused_even_where_dynamodb_types_would_match():
    # [A3] a pure Number Set onto a stored Number Set (no type mismatch) and a DELETE onto a missing
    # row (before the early return) must both still be refused, and write nothing.
    table = FakeTable()
    table.seed({"pk": "N", "sk": "NUMS", "fired": {1}})

    with pytest.raises(ClientError) as add_onto_number_set:
        _update(table, {"pk": "N", "sk": "NUMS"}, "ADD", {2})
    with pytest.raises(ClientError) as delete_on_missing_row:
        _update(table, {"pk": "M", "sk": "MISSING"}, "DELETE", {1})

    assert _code(add_onto_number_set) == "ValidationException"
    assert _code(delete_on_missing_row) == "ValidationException"
    assert table.get_item(Key={"pk": "N", "sk": "NUMS"})["Item"]["fired"] == {1}
    assert table.get_item(Key={"pk": "M", "sk": "MISSING"}) == {}


def test_a_string_set_add_and_delete_still_work():
    # [A4] regression: the new rules must not refuse the app's normal String Set writes.
    table = FakeTable()

    _update(table, {"pk": "N", "sk": "FIRED"}, "ADD", {"a", "b"})
    _update(table, {"pk": "N", "sk": "FIRED"}, "DELETE", {"a"})

    assert table.get_item(Key={"pk": "N", "sk": "FIRED"})["Item"]["fired"] == {"b"}
