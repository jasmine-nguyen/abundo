"""FakeTable must enforce DynamoDB's batch-write rules, or tests can't catch a repeated key (ABU-60)."""

import pytest

from _dynamo_fakes import FakeTable, error_code


def _item(sk, amount):
    return {"pk": "ACCOUNT#a", "sk": sk, "amount": amount}


def test_batch_writer_rejects_one_key_twice_in_a_flush():
    table = FakeTable()
    with pytest.raises(Exception) as excinfo:
        with table.batch_writer() as batch:
            batch.put_item(Item=_item("TXN#1", 1))
            batch.put_item(Item=_item("TXN#1", 2))
    assert error_code(excinfo) == "ValidationException"


def test_batch_writer_with_overwrite_by_pkeys_keeps_the_last_copy():
    table = FakeTable()
    with table.batch_writer(overwrite_by_pkeys=["pk", "sk"]) as batch:
        batch.put_item(Item=_item("TXN#1", 1))
        batch.put_item(Item=_item("TXN#1", 2))
    assert table.store == {("ACCOUNT#a", "TXN#1"): _item("TXN#1", 2)}


def test_batch_writer_allows_one_key_again_in_a_later_flush():
    table = FakeTable()
    with table.batch_writer() as batch:
        batch.put_item(Item=_item("TXN#0", 1))
        for n in range(1, 25):
            batch.put_item(Item=_item(f"TXN#{n}", n))
        batch.put_item(Item=_item("TXN#0", 2))
    assert table.store[("ACCOUNT#a", "TXN#0")]["amount"] == 2
