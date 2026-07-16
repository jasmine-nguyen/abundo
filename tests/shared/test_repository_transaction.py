"""Unit tests for shared/repository_transaction.py — the TransactionRepository
that backs the read API and the sync pipeline, plus its module-level helpers
(sanitise_transaction, _build_pk, _build_sk). Backed by the in-memory FakeTable
and _Field conditions installed in conftest.py.
"""

import json
from datetime import datetime, timezone
from decimal import Decimal

import pytest


# --------------------------------------------------------------------------- #
# module-level helpers                                                         #
# --------------------------------------------------------------------------- #

def test_sanitise_transaction_strips_none_values(shared):
    # None properties are dropped so DynamoDB documents stay sparse...
    txn = {"transaction_id": "t1", "category": None, "merchant_name": None}
    assert shared.repository.sanitise_transaction(txn) == {"transaction_id": "t1"}


def test_sanitise_transaction_keeps_falsy_non_none(shared):
    # ...but falsy-yet-present values (0, "", False) are meaningful and survive.
    txn = {"amount": Decimal("0"), "description": "", "counts_to_budget": False}
    assert shared.repository.sanitise_transaction(txn) == txn


def test_key_builders_prefix_ids(shared):
    assert shared.repository._build_pk("up-spending") == "ACCOUNT#up-spending"
    assert shared.repository._build_sk("txn_1") == "TXN#txn_1"


# --------------------------------------------------------------------------- #
# lazy table + batch-put guards                                               #
# --------------------------------------------------------------------------- #

def test_get_table_lazily_builds_and_caches_the_resource(shared, monkeypatch):
    # A fresh repository (no injected _table) resolves the DynamoDB resource once
    # and buffers it, so the boto3 connection is built lazily and reused. Replace
    # the module's whole `boto3` reference (not an attr on it) so the test does not
    # depend on which suite's fake boto3 is cached in sys.modules first.
    import types as _types

    calls = {"resource": 0, "table": 0}
    sentinel = object()

    class _FakeResource:
        def Table(self, name):
            calls["table"] += 1
            return sentinel

    def fake_resource(*a, **k):
        calls["resource"] += 1
        return _FakeResource()

    monkeypatch.setattr(
        shared.repository, "boto3", _types.SimpleNamespace(resource=fake_resource)
    )

    r = shared.repository.TransactionRepository()
    assert r._get_table() is sentinel
    assert r._get_table() is sentinel  # second call served from the buffer
    assert calls == {"resource": 1, "table": 1}


def test_batch_put_empty_items_is_a_noop(repo):
    # The private guard: an empty item list never opens a batch_writer.
    repo._batch_put([], "batch_write")
    assert repo._table.store == {}


# --------------------------------------------------------------------------- #
# insert_transactions                                                          #
# --------------------------------------------------------------------------- #

def test_insert_transactions_empty_is_a_noop(repo):
    # An empty batch never touches the table (and would 400 a real BatchWrite).
    repo.insert_transactions([])
    assert repo._table.store == {}


def test_insert_transactions_writes_prefixed_keys_and_strips_none(repo):
    repo.insert_transactions([
        {"account_id": "acct", "transaction_id": "t1", "amount": Decimal("-1.00"),
         "category": None},
    ])
    key = ("ACCOUNT#acct", "TXN#t1")
    assert key in repo._table.store
    item = repo._table.store[key]
    assert item["amount"] == Decimal("-1.00")
    assert "category" not in item  # None stripped by sanitise_transaction


def test_insert_transactions_writes_one_row_per_transaction(repo):
    repo.insert_transactions([
        {"account_id": "acct", "transaction_id": "t1"},
        {"account_id": "acct", "transaction_id": "t2"},
    ])
    assert ("ACCOUNT#acct", "TXN#t1") in repo._table.store
    assert ("ACCOUNT#acct", "TXN#t2") in repo._table.store
    assert len(repo._table.store) == 2


def test_insert_transactions_maps_database_error(repo, shared, client_error, database_error, monkeypatch):
    # A ClientError from the batch write is re-raised as a DatabaseError by
    # handle_database_error, never leaked as a raw botocore error.
    def boom():
        raise client_error("ProvisionedThroughputExceededException")

    monkeypatch.setattr(repo._table, "batch_writer", boom)
    with pytest.raises(database_error):
        repo.insert_transactions([{"account_id": "a", "transaction_id": "t"}])


# --------------------------------------------------------------------------- #
# save_failed_transactions                                                     #
# --------------------------------------------------------------------------- #

def test_save_failed_transactions_empty_is_a_noop(repo):
    repo.save_failed_transactions([])
    assert repo._table.store == {}


def test_save_failed_transactions_stores_raw_json_under_failed_partition(repo):
    repo.save_failed_transactions([{"id": "a", "amount": "-1"}])
    failed = [(k, v) for k, v in repo._table.store.items() if k[0] == "FAILED"]
    assert len(failed) == 1
    (_, item) = failed[0]
    assert json.loads(item["raw"]) == {"id": "a", "amount": "-1"}


def test_save_failed_transactions_survive_same_microsecond(repo, shared, monkeypatch):
    # Force both rows to the SAME timestamp; only the uuid in the sort key keeps
    # them from collapsing into one overwritten FAILED row.
    frozen = datetime(2026, 6, 29, 12, 0, 0, tzinfo=timezone.utc)

    class _FrozenDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return frozen

    monkeypatch.setattr(shared.repository, "datetime", _FrozenDatetime)

    repo.save_failed_transactions([{"id": "a"}, {"id": "b"}])

    failed = [k for k in repo._table.store if k[0] == "FAILED"]
    assert len(failed) == 2


# --------------------------------------------------------------------------- #
# get_transactions_by_date_range                                              #
# --------------------------------------------------------------------------- #

def _seed_dated(repo, account_id, dates):
    """Seed one item per date on the given account (date is the GSI sort key)."""
    for d in dates:
        repo._table.store[("ACCOUNT#" + account_id, "TXN#" + d)] = {
            "pk": "ACCOUNT#" + account_id, "sk": "TXN#" + d,
            "account_id": account_id, "date": d,
        }


def test_get_by_date_range_blank_account_returns_empty(repo):
    # Guard clause: no account id → empty page, no query issued.
    items, cursor = repo.get_transactions_by_date_range("", None, None)
    assert items == [] and cursor is None
    assert repo._table.query_calls == 0


def test_get_by_date_range_returns_newest_first(repo):
    _seed_dated(repo, "acct", ["2026-01-01", "2026-01-03", "2026-01-02"])
    items, cursor = repo.get_transactions_by_date_range("acct", None, None)
    assert [it["date"] for it in items] == ["2026-01-03", "2026-01-02", "2026-01-01"]
    assert cursor is None


def test_get_by_date_range_filters_between_two_dates(repo):
    _seed_dated(repo, "acct", ["2026-01-01", "2026-01-05", "2026-01-10"])
    items, _ = repo.get_transactions_by_date_range("acct", "2026-01-02", "2026-01-06")
    assert [it["date"] for it in items] == ["2026-01-05"]


def test_get_by_date_range_start_only_is_inclusive_lower_bound(repo):
    _seed_dated(repo, "acct", ["2026-01-01", "2026-01-05", "2026-01-10"])
    items, _ = repo.get_transactions_by_date_range("acct", "2026-01-05", None)
    assert [it["date"] for it in items] == ["2026-01-10", "2026-01-05"]


def test_get_by_date_range_scopes_to_the_account(repo):
    _seed_dated(repo, "acct", ["2026-01-01"])
    _seed_dated(repo, "other", ["2026-01-02"])
    items, _ = repo.get_transactions_by_date_range("acct", None, None)
    assert [it["account_id"] for it in items] == ["acct"]


def test_get_by_date_range_paginates_with_cursor(repo):
    _seed_dated(repo, "acct", ["2026-01-01", "2026-01-02", "2026-01-03"])
    page1, cursor = repo.get_transactions_by_date_range("acct", None, None, limit=2)
    assert [it["date"] for it in page1] == ["2026-01-03", "2026-01-02"]
    assert cursor is not None

    page2, cursor2 = repo.get_transactions_by_date_range(
        "acct", None, None, limit=2, cursor=cursor
    )
    assert [it["date"] for it in page2] == ["2026-01-01"]
    assert cursor2 is None  # last page → no more cursor


def test_get_by_date_range_caps_limit_at_max_page_size(repo, shared, monkeypatch):
    # The requested limit is clamped to MAX_PAGE_SIZE before hitting DynamoDB.
    captured = {}
    original_query = repo._table.query

    def spy(**kwargs):
        captured.update(kwargs)
        return original_query(**kwargs)

    monkeypatch.setattr(repo._table, "query", spy)
    repo.get_transactions_by_date_range("acct", None, None, limit=10_000)
    assert captured["Limit"] == shared.repository.MAX_PAGE_SIZE


def test_get_by_date_range_maps_database_error(repo, client_error, database_error, monkeypatch):
    def boom(**kwargs):
        raise client_error("InternalServerError")

    monkeypatch.setattr(repo._table, "query", boom)
    with pytest.raises(database_error):
        repo.get_transactions_by_date_range("acct", None, None)


# --------------------------------------------------------------------------- #
# WHIT-123 — shared get_pending_transactions_for_account is DELETED, stays gone #
# --------------------------------------------------------------------------- #

def test_shared_repo_has_no_get_pending_transactions_for_account(shared):
    # WHIT-123 — [A1] regression guard. The shared TransactionRepository must NOT
    # expose get_pending_transactions_for_account: the only correct (paginated)
    # copy lives in lambda/repository.py. The shared method read only DynamoDB's
    # first page, so re-adding it here would silently reintroduce the WHIT-82
    # first-page-only miss for any future caller that binds to the shared repo.
    assert not hasattr(
        shared.repository.TransactionRepository,
        "get_pending_transactions_for_account",
    )


# --------------------------------------------------------------------------- #
# get_transaction_keys_by_id                                                  #
# --------------------------------------------------------------------------- #

def test_get_keys_by_id_returns_pk_and_sk_when_found(repo):
    repo._table.store = {
        ("ACCOUNT#acct", "TXN#t1"): {"pk": "ACCOUNT#acct", "sk": "TXN#t1",
                                     "transaction_id": "t1"},
    }
    assert repo.get_transaction_keys_by_id("t1") == {
        "pk": "ACCOUNT#acct", "sk": "TXN#t1",
    }


def test_get_keys_by_id_returns_none_when_missing(repo):
    assert repo.get_transaction_keys_by_id("nope") is None


def test_get_keys_by_id_returns_first_of_multiple_matches(repo):
    # Duplicate transaction_id in the GSI → repository logs a warning and uses the
    # first match rather than raising.
    repo._table.store = {
        ("ACCOUNT#a", "TXN#dup"): {"pk": "ACCOUNT#a", "sk": "TXN#dup",
                                   "transaction_id": "dup", "date": "2026-01-01"},
        ("ACCOUNT#b", "TXN#dup"): {"pk": "ACCOUNT#b", "sk": "TXN#dup",
                                   "transaction_id": "dup", "date": "2026-01-02"},
    }
    keys = repo.get_transaction_keys_by_id("dup")
    assert keys in (
        {"pk": "ACCOUNT#a", "sk": "TXN#dup"},
        {"pk": "ACCOUNT#b", "sk": "TXN#dup"},
    )


def test_get_keys_by_id_maps_database_error(repo, client_error, database_error, monkeypatch):
    def boom(**kwargs):
        raise client_error("InternalServerError")

    monkeypatch.setattr(repo._table, "query", boom)
    with pytest.raises(database_error):
        repo.get_transaction_keys_by_id("t1")


# --------------------------------------------------------------------------- #
# update_transaction_category                                                 #
# --------------------------------------------------------------------------- #

def test_update_category_sets_value_and_returns_true(repo):
    key = ("ACCOUNT#acct", "TXN#t1")
    repo._table.store = {key: {"pk": key[0], "sk": key[1], "category": "OLD"}}
    assert repo.update_transaction_category(key[0], key[1], "GROCERIES") is True
    assert repo._table.store[key]["category"] == "GROCERIES"


def test_update_category_returns_false_when_row_gone(repo):
    # attribute_exists(pk) guard fails on a row deleted between lookup and update →
    # surfaced as False (a 404), not a 500.
    assert repo.update_transaction_category("ACCOUNT#x", "TXN#gone", "FOOD") is False


def test_update_category_maps_other_database_error(repo, client_error, database_error, monkeypatch):
    # A non-conditional ClientError is still routed through handle_database_error.
    def boom(**kwargs):
        raise client_error("InternalServerError")

    monkeypatch.setattr(repo._table, "update_item", boom)
    with pytest.raises(database_error):
        repo.update_transaction_category("pk", "sk", "FOOD")


# --------------------------------------------------------------------------- #
# update_transaction_fields (WHIT-275)                                         #
# --------------------------------------------------------------------------- #

def test_update_fields_sets_notes_only_leaving_others_intact(repo):
    key = ("ACCOUNT#acct", "TXN#t1")
    repo._table.store = {key: {"pk": key[0], "sk": key[1], "category": "GROCERIES"}}
    assert repo.update_transaction_fields(key[0], key[1], notes="lunch with sam") is True
    row = repo._table.store[key]
    assert row["notes"] == "lunch with sam"
    assert row["category"] == "GROCERIES"  # a field not passed is left untouched
    assert "tags" not in row


def test_update_fields_sets_tags_only(repo):
    key = ("ACCOUNT#acct", "TXN#t1")
    repo._table.store = {key: {"pk": key[0], "sk": key[1]}}
    assert repo.update_transaction_fields(key[0], key[1], tags=["work", "travel"]) is True
    assert repo._table.store[key]["tags"] == ["work", "travel"]


def test_update_fields_sets_category_notes_and_tags_together(repo):
    key = ("ACCOUNT#acct", "TXN#t1")
    repo._table.store = {key: {"pk": key[0], "sk": key[1]}}
    assert repo.update_transaction_fields(
        key[0], key[1], category="FOOD", notes="brunch", tags=["a"]
    ) is True
    row = repo._table.store[key]
    assert (row["category"], row["notes"], row["tags"]) == ("FOOD", "brunch", ["a"])


def test_update_fields_clears_note_by_removing_the_attribute(repo):
    # A cleared note ("") must REMOVE the attribute so it reads back ABSENT, not "".
    key = ("ACCOUNT#acct", "TXN#t1")
    repo._table.store = {key: {"pk": key[0], "sk": key[1], "notes": "old note"}}
    assert repo.update_transaction_fields(key[0], key[1], notes="") is True
    assert "notes" not in repo._table.store[key]


def test_update_fields_clears_tags_by_removing_the_attribute(repo):
    key = ("ACCOUNT#acct", "TXN#t1")
    repo._table.store = {key: {"pk": key[0], "sk": key[1], "tags": ["x"]}}
    assert repo.update_transaction_fields(key[0], key[1], tags=[]) is True
    assert "tags" not in repo._table.store[key]


def test_update_fields_mixes_set_and_remove_in_one_write(repo):
    # Set tags AND clear the note in a single call → the SET/REMOVE combined expression.
    key = ("ACCOUNT#acct", "TXN#t1")
    repo._table.store = {key: {"pk": key[0], "sk": key[1], "notes": "old", "tags": ["x"]}}
    assert repo.update_transaction_fields(key[0], key[1], notes="", tags=["new"]) is True
    row = repo._table.store[key]
    assert row["tags"] == ["new"]
    assert "notes" not in row


# --------------------------------------------------------------------------- #
# budget_excluded override (WHIT-296) — rides the same SET/REMOVE machinery.    #
# --------------------------------------------------------------------------- #

def test_update_fields_sets_budget_excluded_true(repo):
    key = ("ACCOUNT#acct", "TXN#t1")
    repo._table.store = {key: {"pk": key[0], "sk": key[1], "category": "GROCERIES"}}
    assert repo.update_transaction_fields(key[0], key[1], budget_excluded=True) is True
    row = repo._table.store[key]
    assert row["budget_excluded"] is True
    assert row["category"] == "GROCERIES"  # untouched


def test_update_fields_clears_budget_excluded_false_by_removing(repo):
    # False must REMOVE the attribute so it reads back ABSENT (not stored False),
    # matching the sparse notes/tags clear — an absent override means "not excluded".
    key = ("ACCOUNT#acct", "TXN#t1")
    repo._table.store = {key: {"pk": key[0], "sk": key[1], "budget_excluded": True}}
    assert repo.update_transaction_fields(key[0], key[1], budget_excluded=False) is True
    assert "budget_excluded" not in repo._table.store[key]


def test_update_fields_budget_excluded_with_notes_in_one_write(repo):
    # Setting the override AND clearing the note in one call builds a single valid
    # SET+REMOVE UpdateItem (proves the added field slots into the mixed expression).
    key = ("ACCOUNT#acct", "TXN#t1")
    repo._table.store = {key: {"pk": key[0], "sk": key[1], "notes": "old"}}
    assert repo.update_transaction_fields(
        key[0], key[1], notes="", budget_excluded=True
    ) is True
    row = repo._table.store[key]
    assert row["budget_excluded"] is True
    assert "notes" not in row


def test_update_fields_returns_false_when_row_gone(repo):
    # attribute_exists(pk) guard fails on a vanished row → False (a 404), not a 500.
    assert repo.update_transaction_fields("ACCOUNT#x", "TXN#gone", notes="x") is False


def test_update_fields_with_no_fields_is_a_noop_without_writing(repo):
    # All fields _UNSET → nothing to write. It must NOT issue a (malformed) empty-
    # expression UpdateItem: returning True for a MISSING row proves the attribute_
    # exists guard was never reached (a real write would have returned False).
    assert repo.update_transaction_fields("ACCOUNT#x", "TXN#missing") is True


def test_update_fields_maps_other_database_error(repo, client_error, database_error, monkeypatch):
    def boom(**kwargs):
        raise client_error("InternalServerError")

    monkeypatch.setattr(repo._table, "update_item", boom)
    with pytest.raises(database_error):
        repo.update_transaction_fields("pk", "sk", notes="x")


# --------------------------------------------------------------------------- #
# update_transaction_categories (batch, WHIT-70)                              #
# --------------------------------------------------------------------------- #

def test_batch_updates_every_row_and_reports_updated(repo):
    repo._table.store = {
        ("ACCOUNT#a", "TXN#t1"): {"pk": "ACCOUNT#a", "sk": "TXN#t1", "transaction_id": "t1", "category": "OLD"},
        ("ACCOUNT#a", "TXN#t2"): {"pk": "ACCOUNT#a", "sk": "TXN#t2", "transaction_id": "t2", "category": "OLD"},
    }

    results = repo.update_transaction_categories([
        {"id": "t1", "category": "coffee"},
        {"id": "t2", "category": "groceries"},
    ])

    assert results == [
        {"id": "t1", "status": "updated"},
        {"id": "t2", "status": "updated"},
    ]
    assert repo._table.store[("ACCOUNT#a", "TXN#t1")]["category"] == "coffee"
    assert repo._table.store[("ACCOUNT#a", "TXN#t2")]["category"] == "groceries"


def test_batch_unknown_id_is_not_found_others_still_written(repo):
    # An id absent from the GSI → per-item 'not_found', in input order; the known id
    # is still updated (best-effort, not all-or-nothing).
    repo._table.store = {
        ("ACCOUNT#a", "TXN#t1"): {"pk": "ACCOUNT#a", "sk": "TXN#t1", "transaction_id": "t1", "category": "OLD"},
    }

    results = repo.update_transaction_categories([
        {"id": "ghost", "category": "coffee"},
        {"id": "t1", "category": "coffee"},
    ])

    assert results == [
        {"id": "ghost", "status": "not_found"},
        {"id": "t1", "status": "updated"},
    ]
    assert repo._table.store[("ACCOUNT#a", "TXN#t1")]["category"] == "coffee"


def test_batch_conditional_fail_maps_not_found(repo, monkeypatch):
    # Keys resolve, but the conditional update returns False (row vanished between
    # lookup and write) → that id is 'not_found' and the batch keeps going.
    repo._table.store = {
        ("ACCOUNT#a", "TXN#t1"): {"pk": "ACCOUNT#a", "sk": "TXN#t1", "transaction_id": "t1"},
    }
    monkeypatch.setattr(repo, "update_transaction_category", lambda pk, sk, category: False)

    results = repo.update_transaction_categories([{"id": "t1", "category": "coffee"}])

    assert results == [{"id": "t1", "status": "not_found"}]


def test_batch_empty_list_is_a_noop(repo):
    assert repo.update_transaction_categories([]) == []


def test_batch_preserves_input_order_with_mixed_outcomes(repo):
    # >2 items, updated/not_found INTERLEAVED. Results must mirror INPUT order 1:1
    # (not grouped by status, not reordered by which id resolved).
    repo._table.store = {
        ("ACCOUNT#a", "TXN#t1"): {"pk": "ACCOUNT#a", "sk": "TXN#t1", "transaction_id": "t1"},
        ("ACCOUNT#a", "TXN#t3"): {"pk": "ACCOUNT#a", "sk": "TXN#t3", "transaction_id": "t3"},
    }

    results = repo.update_transaction_categories([
        {"id": "t1", "category": "coffee"},
        {"id": "ghost1", "category": "coffee"},
        {"id": "t3", "category": "coffee"},
        {"id": "ghost2", "category": "coffee"},
    ])

    assert results == [
        {"id": "t1", "status": "updated"},
        {"id": "ghost1", "status": "not_found"},
        {"id": "t3", "status": "updated"},
        {"id": "ghost2", "status": "not_found"},
    ]


def test_batch_duplicate_ids_both_applied_last_wins(repo):
    # Same id twice in one batch: each processed independently -> both 'updated', the
    # LAST category written wins on the row.
    repo._table.store = {
        ("ACCOUNT#a", "TXN#t1"): {"pk": "ACCOUNT#a", "sk": "TXN#t1",
                                  "transaction_id": "t1", "category": "OLD"},
    }

    results = repo.update_transaction_categories([
        {"id": "t1", "category": "coffee"},
        {"id": "t1", "category": "groceries"},
    ])

    assert results == [
        {"id": "t1", "status": "updated"},
        {"id": "t1", "status": "updated"},
    ]
    assert repo._table.store[("ACCOUNT#a", "TXN#t1")]["category"] == "groceries"


def test_batch_writes_category_value_verbatim(repo):
    # The row stores the EXACT category string handed in (a raw BankSync enum here) —
    # the repo neither normalises nor enforces the taxonomy.
    repo._table.store = {
        ("ACCOUNT#a", "TXN#t1"): {"pk": "ACCOUNT#a", "sk": "TXN#t1",
                                  "transaction_id": "t1", "category": "OLD"},
    }

    repo.update_transaction_categories([{"id": "t1", "category": "FOOD_AND_DRINK"}])

    assert repo._table.store[("ACCOUNT#a", "TXN#t1")]["category"] == "FOOD_AND_DRINK"


def test_batch_real_client_error_propagates_not_swallowed(repo, client_error, database_error, monkeypatch):
    # MONEY-SAFETY: a NON-conditional ClientError on the write (throttle / 5xx) must
    # propagate as a DatabaseError — NOT be quietly recorded as 'not_found'. A false
    # 'not_found' would tell the client "row gone, revert" while the row is fine.
    repo._table.store = {
        ("ACCOUNT#a", "TXN#t1"): {"pk": "ACCOUNT#a", "sk": "TXN#t1", "transaction_id": "t1"},
    }

    def boom(**kwargs):
        raise client_error("InternalServerError")

    monkeypatch.setattr(repo._table, "update_item", boom)

    with pytest.raises(database_error):
        repo.update_transaction_categories([{"id": "t1", "category": "coffee"}])


def test_batch_error_midloop_keeps_earlier_write_then_raises(repo, client_error, database_error, monkeypatch):
    # The best-effort loop is NOT transactional: if the write throws on the 2nd item,
    # the 1st item's write has ALREADY landed. Documents the partial-write reality
    # (the divergence tracked as tech-debt).
    repo._table.store = {
        ("ACCOUNT#a", "TXN#t1"): {"pk": "ACCOUNT#a", "sk": "TXN#t1",
                                  "transaction_id": "t1", "category": "OLD"},
        ("ACCOUNT#a", "TXN#t2"): {"pk": "ACCOUNT#a", "sk": "TXN#t2",
                                  "transaction_id": "t2", "category": "OLD"},
    }
    original = repo._table.update_item
    seen = []

    def spy(**kwargs):
        seen.append(kwargs["Key"]["sk"])
        if len(seen) == 2:
            raise client_error("InternalServerError")
        return original(**kwargs)

    monkeypatch.setattr(repo._table, "update_item", spy)

    with pytest.raises(database_error):
        repo.update_transaction_categories([
            {"id": "t1", "category": "coffee"},
            {"id": "t2", "category": "coffee"},
        ])

    # First write committed before the raise (loop is not all-or-nothing).
    assert repo._table.store[("ACCOUNT#a", "TXN#t1")]["category"] == "coffee"


def test_save_failed_transactions_stamps_failed_at_and_ttl(repo, shared, monkeypatch):
    # WHIT-54: each dead-letter row carries a readable failed_at (ISO) and an
    # expires_at DynamoDB TTL (epoch seconds) 30 days out, from the same instant.
    frozen = datetime(2026, 6, 29, 12, 0, 0, tzinfo=timezone.utc)

    class _FrozenDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return frozen

    monkeypatch.setattr(shared.repository, "datetime", _FrozenDatetime)

    repo.save_failed_transactions([{"id": "a"}])

    (_, item), = [(k, v) for k, v in repo._table.store.items() if k[0] == "FAILED"]
    assert item["failed_at"] == frozen.isoformat()
    assert item["expires_at"] == int(frozen.timestamp()) + 30 * 24 * 60 * 60
    assert isinstance(item["expires_at"], int)   # TTL must be a Number, not a string
