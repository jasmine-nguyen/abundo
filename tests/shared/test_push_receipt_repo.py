"""Tests for PushReceiptRepository (shared/repository_push_receipt.py) — WHIT-139.

put() stashes {receipt_id -> token} under a single PUSHRECEIPT#PENDING partition with
a 24h TTL, so a later sweep can Query every pending id in one call and unresolved ids
self-reap. A small local fake captures put_item so we assert the exact item shape
without touching DynamoDB.
"""

import pytest


class _FakePutTable:
    """Captures put_item(Item=...) calls the repository issues."""

    def __init__(self):
        self.items = []

    def put_item(self, Item):
        self.items.append(Item)


def _repo(shared):
    r = shared.push_receipt.PushReceiptRepository()
    r._table = _FakePutTable()
    return r


def test_put_stashes_receipt_under_shared_partition_with_ttl(shared, monkeypatch):
    # Freeze the clock so the TTL is exact.
    monkeypatch.setattr(shared.push_receipt.time, "time", lambda: 1_000_000)
    r = _repo(shared)

    r.put("rcpt-1", "ExpoPushToken[a]")

    (item,) = r._table.items
    assert item["pk"] == "PUSHRECEIPT#PENDING"   # one shared partition → sweep Queries, not Scans
    assert item["sk"] == "rcpt-1"                 # one row per receipt id
    assert item["token"] == "ExpoPushToken[a]"
    # 24h TTL from now, so a receipt id the sweep never resolves self-reaps.
    assert shared.push_receipt.RECEIPT_TTL_SECONDS == 24 * 60 * 60
    assert item["expires_at"] == 1_000_000 + shared.push_receipt.RECEIPT_TTL_SECONDS


def test_two_puts_are_distinct_rows_under_one_partition(shared):
    r = _repo(shared)
    r.put("rcpt-1", "ExpoPushToken[a]")
    r.put("rcpt-2", "ExpoPushToken[b]")
    keys = [(it["pk"], it["sk"]) for it in r._table.items]
    assert keys == [("PUSHRECEIPT#PENDING", "rcpt-1"), ("PUSHRECEIPT#PENDING", "rcpt-2")]


def test_put_client_error_surfaces_as_database_error(shared, client_error, database_error):
    # A DynamoDB failure is mapped to the shared DatabaseError (handle_database_error),
    # not a raw ClientError — the repo's error contract, matching the sibling repos.
    r = shared.push_receipt.PushReceiptRepository()

    class _BoomTable:
        def put_item(self, Item):
            raise client_error("InternalServerError")

    r._table = _BoomTable()
    with pytest.raises(database_error):
        r.put("rcpt-1", "ExpoPushToken[a]")
