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


class _FakeQueryTable:
    """Serves preset query pages and records each query(**kwargs) so pagination +
    the KeyConditionExpression can be asserted. ``pages`` is a list of
    ``(items, last_evaluated_key)`` — a non-None key becomes a LastEvaluatedKey."""

    def __init__(self, pages):
        self._pages = pages
        self.query_calls = []

    def query(self, **kwargs):
        items, lek = self._pages[len(self.query_calls)]
        self.query_calls.append(kwargs)
        resp = {"Items": items}
        if lek is not None:
            resp["LastEvaluatedKey"] = lek
        return resp


class _FakeDeleteTable:
    """Captures delete_item(Key=...) calls."""

    def __init__(self):
        self.deleted = []

    def delete_item(self, Key):
        self.deleted.append(Key)


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


# --- list_pending: the sweep's single-partition Query (WHIT-139) -------------


def test_list_pending_returns_all_pairs_across_pages(shared):
    # The whole point of the shared partition: one Query (paged) reads every pending
    # (receipt_id, token). Two pages here prove the LastEvaluatedKey loop.
    r = shared.push_receipt.PushReceiptRepository()
    r._table = _FakeQueryTable([
        ([{"pk": "PUSHRECEIPT#PENDING", "sk": "r1", "token": "t1"}],
         {"pk": "PUSHRECEIPT#PENDING", "sk": "r1"}),
        ([{"pk": "PUSHRECEIPT#PENDING", "sk": "r2", "token": "t2"}], None),
    ])

    out = r.list_pending()

    assert out == [("r1", "t1"), ("r2", "t2")]
    # First call has no cursor; the second carries the page-1 LastEvaluatedKey.
    assert "ExclusiveStartKey" not in r._table.query_calls[0]
    assert r._table.query_calls[1]["ExclusiveStartKey"] == {"pk": "PUSHRECEIPT#PENDING", "sk": "r1"}
    # The Query targets the shared pending partition, not a Scan / other partition.
    cond = r._table.query_calls[0]["KeyConditionExpression"]
    assert cond.evaluate({"pk": "PUSHRECEIPT#PENDING"})
    assert not cond.evaluate({"pk": "SOMETHING#ELSE"})


def test_list_pending_empty_partition_is_empty_list(shared):
    r = shared.push_receipt.PushReceiptRepository()
    r._table = _FakeQueryTable([([], None)])
    assert r.list_pending() == []


def test_list_pending_skips_a_malformed_row_instead_of_aborting(shared):
    # A row missing `token` (a corrupt/foreign write) must be skipped, not KeyError out of
    # the sweep — one bad row would otherwise leave EVERY pending receipt unresolved.
    r = shared.push_receipt.PushReceiptRepository()
    r._table = _FakeQueryTable([([
        {"pk": "PUSHRECEIPT#PENDING", "sk": "r1", "token": "t1"},
        {"pk": "PUSHRECEIPT#PENDING", "sk": "r2"},              # no token → skipped
        {"pk": "PUSHRECEIPT#PENDING", "sk": "r3", "token": "t3"},
    ], None)])

    out = r.list_pending()

    assert out == [("r1", "t1"), ("r3", "t3")]                  # r2 dropped, rest kept


def test_list_pending_client_error_surfaces_as_database_error(shared, client_error, database_error):
    r = shared.push_receipt.PushReceiptRepository()

    class _BoomTable:
        def query(self, **kwargs):
            raise client_error("InternalServerError")

    r._table = _BoomTable()
    with pytest.raises(database_error):
        r.list_pending()


# --- delete: drop a resolved row (WHIT-139) ----------------------------------


def test_delete_removes_the_row_by_shared_partition_key(shared):
    r = shared.push_receipt.PushReceiptRepository()
    r._table = _FakeDeleteTable()
    r.delete("rcpt-1")
    assert r._table.deleted == [{"pk": "PUSHRECEIPT#PENDING", "sk": "rcpt-1"}]


def test_delete_client_error_surfaces_as_database_error(shared, client_error, database_error):
    r = shared.push_receipt.PushReceiptRepository()

    class _BoomTable:
        def delete_item(self, Key):
            raise client_error("InternalServerError")

    r._table = _BoomTable()
    with pytest.raises(database_error):
        r.delete("rcpt-1")
