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
# update_transaction_category_if_unchanged (WHIT-508)                          #
# --------------------------------------------------------------------------- #
# The apply-rules pass reads all of history, decides, then writes up to 15s later. These lock the
# guard that makes the user's own tap in that gap win, and — just as important — that a refusal is
# correctly told apart from a deleted row: reporting a live charge as deleted makes the app drop it
# from the list with nothing to bring it back.

_NO_CATEGORY = object()


def _seed(repo, category=_NO_CATEGORY):
    """Seed one row, with no category attribute at all unless one is given (rows are sparse)."""
    key = ("ACCOUNT#acct", "TXN#t1")
    item = {"pk": key[0], "sk": key[1]}
    if category is not _NO_CATEGORY:
        item["category"] = category
    repo._table.store = {key: item}
    return key


def test_conditional_write_files_a_row_the_scan_saw_unfiled(repo):
    key = _seed(repo)  # no category attribute — what an unfiled row really looks like
    assert repo.update_transaction_category_if_unchanged(*key, "groceries", None) == ("written", "groceries")
    assert repo._table.store[key]["category"] == "groceries"


def test_conditional_write_files_a_row_still_holding_the_scanned_value(repo):
    key = _seed(repo, "FOOD_AND_DRINK")  # a raw bank label still counts as unfiled
    assert repo.update_transaction_category_if_unchanged(*key, "eatingout", "FOOD_AND_DRINK") == ("written", "eatingout")
    assert repo._table.store[key]["category"] == "eatingout"


def test_conditional_write_leaves_a_row_the_user_filed_mid_run(repo):
    # THE CARD. The scan saw no category; the user tapped "coffee" before the write landed.
    # FAIL-ON-REVERT: drop the condition (or compare against the wrong value) and the store below
    # reads "eatingout" — the user's tap silently overwritten, which is the whole bug.
    key = _seed(repo, "coffee")
    assert repo.update_transaction_category_if_unchanged(*key, "eatingout", None) == ("changed", "coffee")
    assert repo._table.store[key]["category"] == "coffee"


def test_conditional_write_reports_the_current_value_so_the_caller_can_judge(repo):
    # A cleared category leaves the row unfiled again. The repository must NOT call that "filed" —
    # it hands back what it found and lets the handler, which holds the taxonomy, decide.
    key = _seed(repo, "TRANSFER_OUT")
    assert repo.update_transaction_category_if_unchanged(*key, "groceries", None) == ("changed", "TRANSFER_OUT")


def test_conditional_write_reports_a_deleted_row_as_gone(repo):
    repo._table.store = {}
    assert repo.update_transaction_category_if_unchanged(
        "ACCOUNT#x", "TXN#gone", "groceries", None) == ("gone", None)


def test_conditional_write_reads_the_row_back_only_when_the_write_is_refused(repo):
    # The probe costs a round trip inside a 15s budget, so it must not run on the happy path.
    key = _seed(repo)
    repo.update_transaction_category_if_unchanged(*key, "groceries", None)
    assert repo._table.get_item_calls == 0

    repo.update_transaction_category_if_unchanged(*key, "eatingout", None)  # now refused
    assert repo._table.get_item_calls == 1
    # STRONGLY consistent, and pinned: the scan reads a secondary index that cannot be read
    # consistently, so a stale read here would reintroduce the very race this method closes.
    # Fail-on-revert: drop ConsistentRead=True and this reddens.
    assert repo._table.consistent_reads == [True]


def test_conditional_write_sets_budget_excluded_alongside_the_category(repo):
    # WHIT-558: a rule that keeps the charge out of budget sets the flag in the SAME write as the
    # category. FAIL-ON-REVERT: drop the `if budget_excluded:` clause and the flag never lands.
    key = _seed(repo)
    assert repo.update_transaction_category_if_unchanged(
        *key, "groceries", None, budget_excluded=True) == ("written", "groceries")
    assert repo._table.store[key]["category"] == "groceries"
    assert repo._table.store[key]["budget_excluded"] is True


def test_conditional_write_omits_budget_excluded_when_false(repo):
    # Sparse storage: a rule that does NOT exclude must not write budget_excluded at all (a stored
    # False would read back as an exclusion). FAIL-ON-REVERT: write it unconditionally and this reddens.
    key = _seed(repo)
    repo.update_transaction_category_if_unchanged(*key, "groceries", None, budget_excluded=False)
    assert "budget_excluded" not in repo._table.store[key]


def test_conditional_write_does_not_exclude_a_row_the_user_filed_mid_run(repo):
    # THE "user hand wins" GUARANTEE at the write: the scan saw the row unfiled and the rule wants to
    # exclude it, but the user filed it in the gap. The whole conditional write is refused, so
    # budget_excluded can NEVER land on a row the tap-wins guard rejected.
    key = _seed(repo, "coffee")
    assert repo.update_transaction_category_if_unchanged(
        *key, "eatingout", None, budget_excluded=True) == ("changed", "coffee")
    assert "budget_excluded" not in repo._table.store[key]


def test_conditional_write_maps_other_database_error(repo, client_error, database_error, monkeypatch):
    def boom(**kwargs):
        raise client_error("InternalServerError")

    monkeypatch.setattr(repo._table, "update_item", boom)
    with pytest.raises(database_error):
        repo.update_transaction_category_if_unchanged("pk", "sk", "groceries", None)


def test_conditional_write_raises_when_the_read_back_fails(repo, client_error, database_error, monkeypatch):
    # A failed probe must NEVER be read as "gone": the handler reports gone rows as vanished and
    # the app then deletes them from the list. An error is an error.
    key = _seed(repo, "coffee")

    def boom(**kwargs):
        raise client_error("ProvisionedThroughputExceededException")

    monkeypatch.setattr(repo._table, "get_item", boom)
    with pytest.raises(database_error):
        repo.update_transaction_category_if_unchanged(*key, "eatingout", None)


def test_conditional_write_handles_an_empty_string_category(repo):
    # The one value that separates the two condition branches: "" is PRESENT, so it must be
    # compared, not treated as absent.
    key = _seed(repo, "")
    assert repo.update_transaction_category_if_unchanged(*key, "groceries", "") == ("written", "groceries")
    assert repo._table.store[key]["category"] == "groceries"


def test_conditional_write_does_not_treat_an_empty_string_as_unfiled(repo):
    key = _seed(repo, "")
    assert repo.update_transaction_category_if_unchanged(*key, "groceries", None) == ("changed", "")


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


# --- folded from test_repository_transaction_whit275_gaps.py (WHIT-463) ---


def test_update_fields_clears_category_when_passed_falsy(repo):  # [A12]
    # The repo REMOVEs category on "" (the #f0 alias REMOVE branch). The handler
    # blocks this at the edge; the repo itself does not — this pins that split.
    key = ("ACCOUNT#acct", "TXN#t1")
    repo._table.store = {key: {"pk": key[0], "sk": key[1], "category": "GROCERIES", "notes": "n"}}
    assert repo.update_transaction_fields(key[0], key[1], category="") is True
    row = repo._table.store[key]
    assert "category" not in row   # category REMOVEd via the #f0 branch
    assert row["notes"] == "n"     # an unpassed field is untouched


def test_update_fields_remove_only_omits_expression_attribute_values(repo, monkeypatch):  # [A13]
    # A REMOVE-only update (clear category) must NOT send ExpressionAttributeValues —
    # DynamoDB rejects an UpdateItem carrying an empty values map. Capture the kwargs
    # the repo hands the table and assert the key is absent entirely.
    key = ("ACCOUNT#acct", "TXN#t1")
    repo._table.store = {key: {"pk": key[0], "sk": key[1], "category": "X"}}
    captured = {}
    original = repo._table.update_item
    def spy(**kwargs):
        captured.update(kwargs)
        return original(**kwargs)
    monkeypatch.setattr(repo._table, "update_item", spy)

    assert repo.update_transaction_fields(key[0], key[1], category="") is True
    assert "ExpressionAttributeValues" not in captured
    assert captured["UpdateExpression"].strip().startswith("REMOVE")


# --------------------------------------------------------------------------- #
# WHIT-508 gaps — what the fake cannot see about HOW the call was made          #
# --------------------------------------------------------------------------- #
# FakeTable answers update_item without caring what expression was handed to it, so the one
# rule DynamoDB itself enforces — every declared expression value must be referenced — is
# invisible to every test above. It fails only in production, on every write.


def _record_updates(repo, monkeypatch):
    """Capture the kwargs of every update_item while still running the real fake underneath.
    (The read-back is already pinned by the fake's own get_item_calls / consistent_reads.)"""
    updates = []
    real_update = repo._table.update_item

    def update_item(**kwargs):
        updates.append(kwargs)
        return real_update(**kwargs)

    monkeypatch.setattr(repo._table, "update_item", update_item)
    return updates


def test_conditional_write_declares_no_unused_expression_value_when_the_row_was_unfiled(
        repo, monkeypatch):
    # [A41] DynamoDB REJECTS an UpdateItem whose ExpressionAttributeValues carries a value the
    # expression never references ("Value provided in ExpressionAttributeValues unused in
    # expressions") — a ValidationException, so every single apply-rules write would 500 in
    # production while every fake stayed green. The attribute_not_exists branch must therefore
    # send `:category` ONLY.
    # FAIL-ON-REVERT: build `values` with `:expected` always present -> red.
    key = _seed(repo)
    updates = _record_updates(repo, monkeypatch)

    repo.update_transaction_category_if_unchanged(*key, "groceries", None)

    assert updates[0]["ConditionExpression"] == "attribute_exists(pk) AND attribute_not_exists(#c)"
    assert set(updates[0]["ExpressionAttributeValues"]) == {":category"}


def test_conditional_write_compares_against_the_scanned_value_when_there_was_one(repo, monkeypatch):
    # [A41b] The other branch, pinned at the wire level: the comparison is against the value the
    # SCAN saw, not the value being written. (The behavioural tests above catch the swap too;
    # this one names the exact expression, so a rewrite of the builder can't drift silently.)
    key = _seed(repo, "FOOD_AND_DRINK")
    updates = _record_updates(repo, monkeypatch)

    repo.update_transaction_category_if_unchanged(*key, "eatingout", "FOOD_AND_DRINK")

    assert updates[0]["ConditionExpression"] == "attribute_exists(pk) AND #c = :expected"
    assert updates[0]["ExpressionAttributeValues"] == {
        ":category": "eatingout", ":expected": "FOOD_AND_DRINK"}


def test_a_row_whose_category_attribute_disappeared_reads_as_changed_not_as_gone(repo):
    # [A42] The dangerous confusion, from the direction nothing else covers: the scan saw a value,
    # the attribute is now ABSENT, and the row still EXISTS. Whatever the cause, an absent
    # attribute is not an absent ROW — answering "gone" has the handler report `vanished` and the
    # app delete a charge the user is looking at. Defensive rather than a named live trigger
    # (clearing is 400'd today, and the re-sync carry only copies truthy values), and
    # catastrophic if it were ever wrong.
    # FAIL-ON-REVERT: return "gone" whenever the read-back has no category -> red.
    key = _seed(repo)  # attribute absent, as a cleared row really is
    assert repo.update_transaction_category_if_unchanged(
        *key, "groceries", "FOOD_AND_DRINK") == ("changed", None)
    assert "category" not in repo._table.store[key]   # nothing was written


def test_a_deleted_row_is_gone_on_the_compare_branch_too(repo):
    # [A43] The suite above proves "gone" only for the attribute_not_exists branch. The compare
    # branch is the one a re-synced row takes, and it must not shortcut the probe and report a
    # deleted row as `changed` holding the value it used to have.
    repo._table.store = {}
    assert repo.update_transaction_category_if_unchanged(
        "ACCOUNT#x", "TXN#gone", "groceries", "FOOD_AND_DRINK") == ("gone", None)


# --------------------------------------------------------------------------- #
# filed_by_rule stamp (WHIT-536) — written on rule-file, cleared on hand-file. #
# --------------------------------------------------------------------------- #

def test_hand_file_single_removes_the_rule_stamp(repo):
    # Filing by hand via update_transaction_fields(category=...) clears the rule stamp.
    key = ("ACCOUNT#acct", "TXN#t1")
    repo._table.store = {key: {"pk": key[0], "sk": key[1], "category": "AUTO", "filed_by_rule": "rule-1"}}
    assert repo.update_transaction_fields(key[0], key[1], category="GROCERIES") is True
    row = repo._table.store[key]
    assert row["category"] == "GROCERIES"
    assert "filed_by_rule" not in row     # stamp gone


def test_notes_only_edit_keeps_the_rule_stamp(repo):
    # A notes/tags/budget-only edit leaves category untouched → the stamp survives.
    key = ("ACCOUNT#acct", "TXN#t1")
    repo._table.store = {key: {"pk": key[0], "sk": key[1], "category": "AUTO", "filed_by_rule": "rule-1"}}
    assert repo.update_transaction_fields(key[0], key[1], notes="lunch") is True
    row = repo._table.store[key]
    assert row["filed_by_rule"] == "rule-1"   # stamp kept
    assert row["notes"] == "lunch"


def test_hand_file_batch_removes_the_rule_stamp(repo):
    # The batch hand-file path (update_transaction_category) clears the stamp too.
    key = ("ACCOUNT#acct", "TXN#t1")
    repo._table.store = {key: {"pk": key[0], "sk": key[1], "category": "AUTO", "filed_by_rule": "rule-1"}}
    assert repo.update_transaction_category(key[0], key[1], "GROCERIES") is True
    row = repo._table.store[key]
    assert row["category"] == "GROCERIES"
    assert "filed_by_rule" not in row


def test_hand_file_batch_on_an_unstamped_row_is_a_safe_noop_remove(repo):
    # REMOVE of an absent stamp must not error — a never-ruled charge files fine.
    key = ("ACCOUNT#acct", "TXN#t1")
    repo._table.store = {key: {"pk": key[0], "sk": key[1], "category": "OLD"}}
    assert repo.update_transaction_category(key[0], key[1], "GROCERIES") is True
    assert repo._table.store[key]["category"] == "GROCERIES"


def test_on_demand_rule_file_stamps_the_rule_id(repo):
    # update_transaction_category_if_unchanged writes the stamp when given a rule id.
    key = ("ACCOUNT#acct", "TXN#t1")
    repo._table.store = {key: {"pk": key[0], "sk": key[1]}}   # unfiled (no category)
    status, _ = repo.update_transaction_category_if_unchanged(
        key[0], key[1], "GROCERIES", None, filed_by_rule="rule-9")
    assert status == "written"
    row = repo._table.store[key]
    assert row["category"] == "GROCERIES"
    assert row["filed_by_rule"] == "rule-9"


def test_on_demand_without_a_rule_id_writes_no_stamp(repo):
    # Back-compat: the default filed_by_rule=None leaves the write stamp-free.
    key = ("ACCOUNT#acct", "TXN#t1")
    repo._table.store = {key: {"pk": key[0], "sk": key[1]}}
    status, _ = repo.update_transaction_category_if_unchanged(key[0], key[1], "GROCERIES", None)
    assert status == "written"
    assert "filed_by_rule" not in repo._table.store[key]

# --- WHIT-536 GAP: clear-by-hand and the tap-wins guard vs the stamp ---

def _seed_row(repo, **item):
    key = ("ACCOUNT#acct", "TXN#t1")
    repo._table.store = {key: {"pk": key[0], "sk": key[1], **item}}
    return key


# [G4] [A2] Clearing the category by HAND (category="") also removes the stamp. The impl
# hand-file test uses a truthy category (SET+REMOVE branch); the "" clear goes down the
# REMOVE-only branch. FAIL-ON-REVERT: drop the `if category is not _UNSET` REMOVE #p and the
# stamp survives a category clear.
def test_whit536_clearing_category_by_hand_removes_the_stamp(repo):
    key = _seed_row(repo, category="GROCERIES", filed_by_rule="rule-1", notes="n")
    assert repo.update_transaction_fields(*key, category="") is True
    row = repo._table.store[key]
    assert "category" not in row
    assert "filed_by_rule" not in row
    assert row["notes"] == "n"


# [G5] [A6] The tap-wins guard REFUSES to stamp a row it rejects. A charge already hand-filed
# ("coffee") is matched by the sweep, which calls the conditional write with expected=None and a
# rule stamp. attribute_not_exists(#c) fails -> the whole write is refused atomically, so NEITHER
# the rule category NOR the stamp lands. FAIL-ON-REVERT: make the stamped write drop the
# attribute_not_exists guard and the stamp overwrites the hand-filed row.
def test_whit536_rejected_write_lands_no_stamp_on_hand_filed_row(repo):
    key = _seed_row(repo, category="coffee")
    status, current = repo.update_transaction_category_if_unchanged(
        *key, "groceries", None, filed_by_rule="rule-9")
    assert status == "changed"
    assert current == "coffee"
    row = repo._table.store[key]
    assert row["category"] == "coffee"
    assert "filed_by_rule" not in row


# [G6] [A7] Wire-level: the STAMPED conditional write against a scanned value must not declare an
# unused ExpressionAttributeValue (DynamoDB 500s on that). FAIL-ON-REVERT: build values with
# :rule but leave #p out of the expression -> red.
def test_whit536_stamped_write_declares_no_unused_expression_value(repo, monkeypatch):
    key = _seed_row(repo, category="OLD")
    captured = {}
    original = repo._table.update_item
    def spy(**kwargs):
        captured.update(kwargs)
        return original(**kwargs)
    monkeypatch.setattr(repo._table, "update_item", spy)

    repo.update_transaction_category_if_unchanged(*key, "groceries", "OLD", filed_by_rule="rule-9")

    expr = captured["UpdateExpression"] + " " + captured["ConditionExpression"]
    declared = set(captured["ExpressionAttributeValues"])
    assert declared == {":category", ":expected", ":rule"}
    for value_alias in declared:
        assert value_alias in expr


# --------------------------------------------------------------------------- #
# clear_rule_fill / refile_rule_fill (WHIT-540) — undo / re-file a rule's fill #
# on ONE charge, guarded by the STAMP so a user's tap in the gap always wins.  #
# --------------------------------------------------------------------------- #

def test_clear_rule_fill_removes_category_and_stamp_when_the_stamp_matches(repo):
    # The delete-undo (and edit-no-longer-matches) path: a rule-owned charge goes back to unfiled.
    key = _seed_row(repo, category="groceries", filed_by_rule="rule-1", notes="keep")
    assert repo.clear_rule_fill(*key, "rule-1") is True
    row = repo._table.store[key]
    assert "category" not in row
    assert "filed_by_rule" not in row
    assert row["notes"] == "keep"          # only the fill is undone, not the user's own fields


def test_clear_rule_fill_leaves_a_charge_whose_stamp_no_longer_matches(repo):
    # THE TAP-WINS GUARD. The user hand-filed since (the stamp was REMOVEd, so it's now absent or a
    # different rule), so deleting the OLD rule must not touch their choice. FAIL-ON-REVERT: condition
    # on attribute_exists(pk) alone (drop the `#p = :rule_id`) and this charge is wrongly un-filed.
    key = _seed_row(repo, category="coffee")          # user re-filed; stamp gone
    assert repo.clear_rule_fill(*key, "rule-1") is False
    assert repo._table.store[key]["category"] == "coffee"


def test_clear_rule_fill_leaves_a_charge_owned_by_a_different_rule(repo):
    key = _seed_row(repo, category="petrol", filed_by_rule="rule-2")
    assert repo.clear_rule_fill(*key, "rule-1") is False
    row = repo._table.store[key]
    assert row["category"] == "petrol" and row["filed_by_rule"] == "rule-2"


def test_clear_rule_fill_on_a_vanished_row_is_a_false_noop(repo):
    repo._table.store = {}
    assert repo.clear_rule_fill("ACCOUNT#x", "TXN#gone", "rule-1") is False


def test_clear_rule_fill_is_idempotent(repo):
    # Running it twice is safe: the second call finds the stamp already gone and no-ops.
    key = _seed_row(repo, category="groceries", filed_by_rule="rule-1")
    assert repo.clear_rule_fill(*key, "rule-1") is True
    assert repo.clear_rule_fill(*key, "rule-1") is False


def test_refile_rule_fill_moves_category_and_rekeys_the_stamp(repo):
    # The edit-still-matches path: a charge the rule owns moves to the new target and the stamp is
    # re-keyed to the (possibly new) id. Here the text changed, so old id -> new id.
    key = _seed_row(repo, category="groceries", filed_by_rule="old-id", notes="keep")
    assert repo.refile_rule_fill(*key, "eatingout", "old-id", "new-id") is True
    row = repo._table.store[key]
    assert row["category"] == "eatingout"
    assert row["filed_by_rule"] == "new-id"
    assert row["notes"] == "keep"


def test_refile_rule_fill_in_place_edit_keeps_the_id_moves_the_category(repo):
    # A target-only (or cosmetic) edit keeps the id: old == new, only the category moves.
    key = _seed_row(repo, category="groceries", filed_by_rule="same-id")
    assert repo.refile_rule_fill(*key, "petrol", "same-id", "same-id") is True
    row = repo._table.store[key]
    assert row["category"] == "petrol" and row["filed_by_rule"] == "same-id"


def test_refile_rule_fill_leaves_a_charge_the_user_refiled_in_the_gap(repo):
    # TAP-WINS for the re-file path. The user hand-filed to the SAME category during the scan->write
    # gap (so the stamp was REMOVEd). A CATEGORY guard would pass and re-capture their charge; the
    # STAMP guard refuses. FAIL-ON-REVERT: condition this write on the category and the stamp lands
    # back on a charge the user just took ownership of.
    key = _seed_row(repo, category="eatingout")       # user re-filed to the new target; stamp gone
    assert repo.refile_rule_fill(*key, "eatingout", "old-id", "new-id") is False
    row = repo._table.store[key]
    assert row["category"] == "eatingout"
    assert "filed_by_rule" not in row                 # not re-stamped


def test_refile_rule_fill_on_a_vanished_row_is_a_false_noop(repo):
    repo._table.store = {}
    assert repo.refile_rule_fill("ACCOUNT#x", "TXN#gone", "groceries", "old", "new") is False
