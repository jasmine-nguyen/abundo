"""Pins the one general stand-in table, FakeTable (WHIT-625 slice 1).

FakeTable interprets DynamoDB's expression grammar (the forms the repositories use) instead of
matching whitelisted strings, so the real repositories can run over it unchanged. Anything outside
that grammar must raise, never pass silently.

It also pins FakeTable's set rules (WHIT-636): DynamoDB refuses an empty set in ADD/DELETE, and (an
app rule, stricter than DynamoDB) the app stores only String Sets, so a set holding numbers is refused.
The empty-set rule also covers SET, put_item and the batch writer (WHIT-676, pinned in
test_whit676_empty_set_writes.py).
"""

import pytest
from botocore.exceptions import ClientError

from _boto_stubs import _Field
from _dynamo_fakes import FakeTable, error_code


def _is_row(key, pk, sk):
    """`when` / hook keys may arrive as the Key dict or the (pk, sk) store key."""
    if isinstance(key, dict):
        return (key["pk"], key["sk"]) == (pk, sk)
    return tuple(key) == (pk, sk)


def test_fake_table_interprets_dynamodb_expressions_and_offers_test_hooks():
    table = FakeTable()
    table.seed(
        {"pk": "CFG", "sk": "CFG", "version": 1,
         "items": {"food": {"name": "Food", "parent": None, "meta": {"slot": 1}}}},
        {"pk": "N", "sk": "FIRED", "count": 1, "fired": {"a", "b"}},
    )

    # Nested SET at any depth (#items.#id.#meta.#slot), guarded by a version lock and a
    # nested attribute_not_exists — the category store's shape.
    table.update_item(
        Key={"pk": "CFG", "sk": "CFG"},
        UpdateExpression="SET #items.#new = :cat, #items.#id.#meta.#slot = :slot, #v = :next",
        ConditionExpression="attribute_exists(pk) AND #v = :expected AND attribute_not_exists(#items.#new)",
        ExpressionAttributeNames={"#items": "items", "#new": "gym", "#id": "food",
                                  "#meta": "meta", "#slot": "slot", "#v": "version"},
        ExpressionAttributeValues={":cat": {"name": "Gym"}, ":slot": 7, ":next": 2, ":expected": 1},
    )
    item = table.get_item(Key={"pk": "CFG", "sk": "CFG"})["Item"]
    assert item["version"] == 2
    assert item["items"]["gym"] == {"name": "Gym"}
    assert item["items"]["food"]["meta"] == {"slot": 7}

    # Adding the same category again → the nested attribute_not_exists refuses it.
    with pytest.raises(ClientError) as refused:
        table.update_item(
            Key={"pk": "CFG", "sk": "CFG"},
            UpdateExpression="SET #items.#new = :cat",
            ConditionExpression="attribute_not_exists(#items.#new)",
            ExpressionAttributeNames={"#items": "items", "#new": "gym"},
            ExpressionAttributeValues={":cat": {"name": "Other"}},
        )
    assert error_code(refused) == "ConditionalCheckFailedException"

    # Nested REMOVE, with <> and parenthesised OR in the condition.
    table.update_item(
        Key={"pk": "CFG", "sk": "CFG"},
        UpdateExpression="REMOVE #items.#new",
        ConditionExpression="#v <> :other AND (attribute_exists(#items.#new) OR #v = :other)",
        ExpressionAttributeNames={"#items": "items", "#new": "gym", "#v": "version"},
        ExpressionAttributeValues={":other": 99},
    )
    assert "gym" not in table.get_item(Key={"pk": "CFG", "sk": "CFG"})["Item"]["items"]

    # ADD grows a number and a set; SET in the same expression; the conditional claim form.
    table.update_item(
        Key={"pk": "N", "sk": "FIRED"},
        UpdateExpression="ADD #f :m, #n :one SET #e = :exp",
        ConditionExpression="attribute_not_exists(#f) OR NOT contains(#f, :v)",
        ExpressionAttributeNames={"#f": "fired", "#n": "count", "#e": "expires_at"},
        ExpressionAttributeValues={":m": {"c"}, ":v": "c", ":one": 1, ":exp": 100},
    )
    item = table.get_item(Key={"pk": "N", "sk": "FIRED"})["Item"]
    assert item["fired"] == {"a", "b", "c"}
    assert item["count"] == 2
    assert item["expires_at"] == 100

    # Claiming a marker that is already in the set is refused.
    with pytest.raises(ClientError) as claimed:
        table.update_item(
            Key={"pk": "N", "sk": "FIRED"},
            UpdateExpression="ADD #f :m",
            ConditionExpression="attribute_not_exists(#f) OR NOT contains(#f, :v)",
            ExpressionAttributeNames={"#f": "fired"},
            ExpressionAttributeValues={":m": {"a"}, ":v": "a"},
        )
    assert error_code(claimed) == "ConditionalCheckFailedException"

    # ADD on an absent row creates it; DELETE of the last members drops the attribute.
    table.update_item(
        Key={"pk": "M", "sk": "FIRED"},
        UpdateExpression="ADD #f :m",
        ExpressionAttributeNames={"#f": "fired"},
        ExpressionAttributeValues={":m": {"x", "y"}},
    )
    table.update_item(
        Key={"pk": "M", "sk": "FIRED"},
        UpdateExpression="DELETE #f :m",
        ExpressionAttributeNames={"#f": "fired"},
        ExpressionAttributeValues={":m": {"x", "y"}},
    )
    assert table.get_item(Key={"pk": "M", "sk": "FIRED"})["Item"] == {"pk": "M", "sk": "FIRED"}

    # Reads and writes are deep copies: mutating a returned nested map changes nothing stored.
    read = table.get_item(Key={"pk": "CFG", "sk": "CFG"})["Item"]
    read["items"]["food"]["name"] = "Mutated"
    assert table.get_item(Key={"pk": "CFG", "sk": "CFG"})["Item"]["items"]["food"]["name"] == "Food"

    # Syntax outside the grammar fails loudly instead of passing.
    with pytest.raises(AssertionError):
        table.update_item(
            Key={"pk": "N", "sk": "FIRED"},
            UpdateExpression="SET #e = :exp",
            ConditionExpression="begins_with(#e, :p)",
            ExpressionAttributeNames={"#e": "expires_at"},
            ExpressionAttributeValues={":exp": 1, ":p": "1"},
        )

    # DynamoDB's 4KB UpdateExpression ceiling → ValidationException, nothing written.
    names = {f"#a{i}": f"attr{i}" for i in range(400)}
    too_big = "SET " + ", ".join(f"#a{i} = :v" for i in range(400))
    assert len(too_big.encode()) > 4096
    with pytest.raises(ClientError) as too_large:
        table.update_item(
            Key={"pk": "N", "sk": "FIRED"},
            UpdateExpression=too_big,
            ExpressionAttributeNames=names,
            ExpressionAttributeValues={":v": 1},
        )
    assert error_code(too_large) == "ValidationException"
    assert "attr0" not in table.get_item(Key={"pk": "N", "sk": "FIRED"})["Item"]

    # --- Hooks: make a call fail, race a write, serve a stale index. ---
    table = FakeTable()
    table.seed(
        {"pk": "ACC#1", "sk": "T1", "account_id": "1", "date": "2026-09-01",
         "transaction_id": "t1", "category": None},
        {"pk": "ACC#1", "sk": "T2", "account_id": "1", "date": "2026-09-02",
         "transaction_id": "t2", "category": None},
        {"pk": "CFG", "sk": "CFG", "version": 1},
    )

    # fail(): only the matching row's write raises, with a throttle by default; others succeed.
    table.fail("update_item", when=lambda key: _is_row(key, "ACC#1", "T1"))
    with pytest.raises(ClientError) as failed:
        table.update_item(
            Key={"pk": "ACC#1", "sk": "T1"}, UpdateExpression="SET #c = :c",
            ExpressionAttributeNames={"#c": "category"}, ExpressionAttributeValues={":c": "food"},
        )
    assert error_code(failed) == "ProvisionedThroughputExceededException"
    table.update_item(
        Key={"pk": "ACC#1", "sk": "T2"}, UpdateExpression="SET #c = :c",
        ExpressionAttributeNames={"#c": "category"}, ExpressionAttributeValues={":c": "food"},
    )
    assert table.get_item(Key={"pk": "ACC#1", "sk": "T2"})["Item"]["category"] == "food"

    # before_write(): a concurrent writer bumps the version between read and write → the
    # version-locked update is refused.
    raced = []

    def concurrent_writer(key, tbl):
        if raced or not _is_row(key, "CFG", "CFG"):
            return
        raced.append(key)
        tbl.put_item(Item={"pk": "CFG", "sk": "CFG", "version": 2})

    table.before_write(concurrent_writer)
    with pytest.raises(ClientError) as lost_race:
        table.update_item(
            Key={"pk": "CFG", "sk": "CFG"}, UpdateExpression="SET #v = :next",
            ConditionExpression="attribute_exists(pk) AND #v = :expected",
            ExpressionAttributeNames={"#v": "version"},
            ExpressionAttributeValues={":next": 2, ":expected": 1},
        )
    assert error_code(lost_race) == "ConditionalCheckFailedException"
    assert raced

    assert table.update_calls

    # stale_index(): a query through an index sees the overlay; a direct read sees the truth.
    table.stale_index({"pk": "ACC#1", "sk": "T2"}, category=None)
    page = table.query(
        IndexName="date-index",
        KeyConditionExpression=_Field("account_id").eq("1"),
        ScanIndexForward=False,
        Limit=1,
    )
    assert [row["transaction_id"] for row in page["Items"]] == ["t2"]
    assert page["Items"][0]["category"] is None
    assert table.get_item(Key={"pk": "ACC#1", "sk": "T2"}, ConsistentRead=True)["Item"]["category"] == "food"
    # An index page's cursor carries the index's own keys.
    assert page["LastEvaluatedKey"] == {
        "account_id": "1", "date": "2026-09-02", "pk": "ACC#1", "sk": "T2"}


def test_real_notify_repository_runs_over_the_fake_table(shared, database_error):
    table = FakeTable()
    notify = shared.notify.NotifyRepository()
    notify._table = table

    assert notify.claim_fired("2026-09-01", 14, "groceries#80") is True
    assert notify.claim_fired("2026-09-01", 14, "groceries#80") is False
    assert notify.fired_markers("2026-09-01", 14) == {"groceries#80"}

    notify.release_fired("2026-09-01", 14, "groceries#80")
    assert notify.fired_markers("2026-09-01", 14) == set()
    assert notify.claim_fired("2026-09-01", 14, "groceries#80") is True

    notify.mark_milestone_fired("id:m1:bal:100000")
    notify.migrate_milestone_markers([("id:m1:bal:100000", "id:m2:bal:100000")])
    assert notify.fired_milestones() == {"id:m2:bal:100000"}

    # A failed call surfaces as the app's DatabaseError, converted by the real repository.
    table.fail("update_item")
    with pytest.raises(database_error):
        notify.mark_fired("2026-09-01", 14, "rent#100")


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

    assert error_code(empty_add) == "ValidationException"
    assert error_code(empty_delete) == "ValidationException"
    assert error_code(empty_delete_missing_attribute) == "ValidationException"
    assert error_code(empty_delete_missing_row) == "ValidationException"
    assert table.get_item(Key={"pk": "N", "sk": "FIRED"})["Item"]["fired"] == {"a"}
    assert table.get_item(Key={"pk": "E", "sk": "EMPTY"})["Item"] == {"pk": "E", "sk": "EMPTY"}
    assert table.get_item(Key={"pk": "M", "sk": "MISSING"}) == {}


def test_a_first_add_of_a_number_set_is_rejected_and_creates_no_row():
    table = FakeTable()

    with pytest.raises(ClientError) as number_set:
        _update(table, {"pk": "N", "sk": "FIRED"}, "ADD", {1})

    assert error_code(number_set) == "ValidationException"
    assert table.get_item(Key={"pk": "N", "sk": "FIRED"}) == {}
