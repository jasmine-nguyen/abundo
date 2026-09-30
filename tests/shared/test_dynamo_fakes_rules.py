"""FakeTable behaviour beyond the pinned grammar (WHIT-625): DynamoDB's unused-name and set-type
rules, the one-shot write queue, clearing failures, and the call recorders. The empty-set and
number-set rules (WHIT-636) are pinned in test_dynamo_fakes_set_rules.py."""

import pytest
from botocore.exceptions import ClientError

from _boto_stubs import _Field
from _dynamo_fakes import FakeTable


def _code(excinfo):
    return excinfo.value.response["Error"]["Code"]


def test_a_declared_name_or_value_no_expression_uses_is_rejected():
    table = FakeTable()
    table.seed({"pk": "A", "sk": "A", "count": 1})

    # "#c1" appears only as a prefix of "#c10" — the rule is word-boundary, not substring.
    with pytest.raises(ClientError) as unused_name:
        table.update_item(
            Key={"pk": "A", "sk": "A"}, UpdateExpression="SET #c10 = :v",
            ExpressionAttributeNames={"#c1": "one", "#c10": "ten"},
            ExpressionAttributeValues={":v": 1},
        )
    with pytest.raises(ClientError) as unused_value:
        table.update_item(
            Key={"pk": "A", "sk": "A"}, UpdateExpression="SET #c = :v",
            ExpressionAttributeNames={"#c": "count"},
            ExpressionAttributeValues={":v": 2, ":spare": 3},
        )

    assert _code(unused_name) == "ValidationException"
    assert _code(unused_value) == "ValidationException"
    assert table.get_item(Key={"pk": "A", "sk": "A"})["Item"]["count"] == 1


def test_a_set_under_a_missing_parent_map_is_rejected_and_writes_nothing():
    table = FakeTable()
    table.seed({"pk": "A", "sk": "A", "version": 1})

    with pytest.raises(ClientError) as invalid:
        table.update_item(
            Key={"pk": "A", "sk": "A"}, UpdateExpression="SET #v = :next, #items.#id = :val",
            ExpressionAttributeNames={"#v": "version", "#items": "items", "#id": "x"},
            ExpressionAttributeValues={":next": 2, ":val": 1},
        )

    assert _code(invalid) == "ValidationException"
    assert table.get_item(Key={"pk": "A", "sk": "A"})["Item"] == {"pk": "A", "sk": "A", "version": 1}


def test_a_number_added_to_a_string_set_is_rejected_and_writes_nothing():
    table = FakeTable()
    table.seed({"pk": "A", "sk": "A", "fired": {"0"}})

    with pytest.raises(ClientError) as into_existing:
        table.update_item(Key={"pk": "A", "sk": "A"}, UpdateExpression="ADD #f :m",
                          ExpressionAttributeNames={"#f": "fired"}, ExpressionAttributeValues={":m": {1}})
    with pytest.raises(ClientError) as mixed:
        table.update_item(Key={"pk": "B", "sk": "B"}, UpdateExpression="ADD #f :m",
                          ExpressionAttributeNames={"#f": "fired"}, ExpressionAttributeValues={":m": {"a", 1}})

    assert _code(into_existing) == "ValidationException"
    assert _code(mixed) == "ValidationException"
    assert table.get_item(Key={"pk": "A", "sk": "A"})["Item"]["fired"] == {"0"}
    assert table.get_item(Key={"pk": "B", "sk": "B"}) == {}


def test_get_item_records_each_key_in_call_order():
    table = FakeTable()

    table.get_item(Key={"pk": "A", "sk": "1"})
    table.get_item(Key={"pk": "B", "sk": "2"})

    assert table.get_item_keys == [{"pk": "A", "sk": "1"}, {"pk": "B", "sk": "2"}]


def test_queued_one_shot_writers_take_successive_writes_in_order():
    table = FakeTable()
    table.seed({"pk": "A", "sk": "A", "n": 0})
    seen = []
    table.before_next_write(lambda key, tbl: seen.append("first"))
    table.before_next_write(lambda key, tbl: seen.append("second"))

    for value in (1, 2, 3):
        table.update_item(
            Key={"pk": "A", "sk": "A"}, UpdateExpression="SET #n = :n",
            ExpressionAttributeNames={"#n": "n"}, ExpressionAttributeValues={":n": value},
        )

    assert seen == ["first", "second"]


def test_race_next_update_loses_one_locked_write_and_always_race_loses_every_one():
    def locked_bump(table):
        version = table.get_item(Key={"pk": "A", "sk": "A"})["Item"]["version"]
        table.update_item(
            Key={"pk": "A", "sk": "A"}, UpdateExpression="SET #v = :next",
            ConditionExpression="attribute_exists(pk) AND #v = :expected",
            ExpressionAttributeNames={"#v": "version"},
            ExpressionAttributeValues={":next": version + 1, ":expected": version},
        )

    once = FakeTable()
    once.seed({"pk": "A", "sk": "A", "version": 1})
    once.race_next_update()
    with pytest.raises(ClientError):
        locked_bump(once)
    locked_bump(once)
    assert once.store[("A", "A")]["version"] == 3  # the rival's bump, then ours

    always = FakeTable()
    always.seed({"pk": "A", "sk": "A", "version": 1})
    always.always_race()
    for _ in range(3):
        with pytest.raises(ClientError):
            locked_bump(always)


def test_fail_keeps_failing_until_cleared_and_can_raise_a_given_error():
    table = FakeTable()
    table.seed({"pk": "A", "sk": "A"})
    table.fail("get_item", error=TimeoutError("connect timeout"))

    for _ in range(2):
        with pytest.raises(TimeoutError):
            table.get_item(Key={"pk": "A", "sk": "A"})
    table.clear_failures()

    assert table.get_item(Key={"pk": "A", "sk": "A"})["Item"] == {"pk": "A", "sk": "A"}


def test_queries_are_recorded_and_a_transaction_id_page_cursor_carries_that_index_key():
    table = FakeTable()
    table.seed(
        {"pk": "ACC#1", "sk": "T1", "transaction_id": "t1", "date": "2026-09-01"},
        {"pk": "ACC#2", "sk": "T9", "transaction_id": "t1", "date": "2026-09-02"},
    )

    page = table.query(IndexName="transaction-id-index",
                       KeyConditionExpression=_Field("transaction_id").eq("t1"), Limit=1)

    assert page["LastEvaluatedKey"] == {"transaction_id": "t1", "pk": "ACC#1", "sk": "T1"}
    assert table.query_calls == 1
    assert table.queries[0]["IndexName"] == "transaction-id-index"
    assert table.queries[0]["Limit"] == 1


def test_an_unknown_index_or_query_argument_fails_loudly():
    table = FakeTable()

    with pytest.raises(AssertionError):
        table.query(IndexName="category-index", KeyConditionExpression=_Field("pk").eq("A"))
    with pytest.raises(AssertionError):
        table.query(KeyConditionExpression=_Field("pk").eq("A"), Select="COUNT")


def test_page_size_cuts_the_key_matched_rows_before_the_filter_runs():
    # DynamoDB reads up to 1MB of key-matched rows, THEN filters that page: a row the filter keeps
    # can sit on a later page behind a page the filter empties.
    table = FakeTable()
    table.seed(
        {"pk": "P", "sk": "a", "status": "POSTED"},
        {"pk": "P", "sk": "b", "status": "POSTED"},
        {"pk": "P", "sk": "c", "status": "PENDING"},
    )
    table.page_size = 2
    pending = {"KeyConditionExpression": _Field("pk").eq("P"),
               "FilterExpression": _Field("status").eq("PENDING")}

    first = table.query(**pending)
    second = table.query(**pending, ExclusiveStartKey=first["LastEvaluatedKey"])

    assert first == {"Items": [], "LastEvaluatedKey": {"pk": "P", "sk": "b"}}
    assert second == {"Items": [{"pk": "P", "sk": "c", "status": "PENDING"}]}
