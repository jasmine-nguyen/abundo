"""WHIT-636 QA: FakeTable's empty-set rule on the edges the build's own tests leave open."""

import pytest
from botocore.exceptions import ClientError

from _dynamo_fakes import FakeTable, error_code


def test_an_empty_first_add_on_a_missing_row_is_rejected_and_creates_no_row():
    # [A1] without the rule, ADD onto a missing row would create it holding an empty set.
    table = FakeTable()

    with pytest.raises(ClientError) as empty_add:
        table.update_item(Key={"pk": "N", "sk": "FIRED"}, UpdateExpression="ADD #f :m",
                          ExpressionAttributeNames={"#f": "fired"}, ExpressionAttributeValues={":m": set()})

    assert error_code(empty_add) == "ValidationException"
    assert table.get_item(Key={"pk": "N", "sk": "FIRED"}) == {}


def test_an_empty_set_alongside_a_set_clause_writes_neither_clause():
    # [A2] the app's real shape (mark_fired: "ADD #f :m SET #e = :exp") — the SET must not land.
    table = FakeTable()
    table.seed({"pk": "N", "sk": "FIRED", "fired": {"a"}, "expires": 1})

    with pytest.raises(ClientError) as empty_add:
        table.update_item(Key={"pk": "N", "sk": "FIRED"}, UpdateExpression="ADD #f :m SET #e = :exp",
                          ExpressionAttributeNames={"#f": "fired", "#e": "expires"},
                          ExpressionAttributeValues={":m": set(), ":exp": 2})

    assert error_code(empty_add) == "ValidationException"
    assert table.get_item(Key={"pk": "N", "sk": "FIRED"})["Item"] == {
        "pk": "N", "sk": "FIRED", "fired": {"a"}, "expires": 1}
