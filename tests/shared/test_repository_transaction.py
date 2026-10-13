"""Unit tests for shared/repository_transaction.py — the TransactionRepository
that backs the read API and the sync pipeline, plus its module-level helpers
(sanitise_transaction, _build_pk, _build_sk). Backed by the in-memory FakeTable
and _Field conditions installed in conftest.py.
"""

import json
from datetime import datetime, timezone
from decimal import Decimal

import pytest
from _transaction_range_fakes import _EndlessTransactionRepo


# --------------------------------------------------------------------------- #
# module-level helpers                                                         #
# --------------------------------------------------------------------------- #


def test_sanitise_transaction_keeps_falsy_non_none(shared):
    # ...but falsy-yet-present values (0, "", False) are meaningful and survive.
    txn = {"amount": Decimal("0"), "description": "", "counts_to_budget": False}
    assert shared.repository.sanitise_transaction(txn) == txn


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


# --------------------------------------------------------------------------- #
# save_failed_transactions                                                     #
# --------------------------------------------------------------------------- #


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


def test_get_by_date_range_returns_newest_first(repo):
    _seed_dated(repo, "acct", ["2026-01-01", "2026-01-03", "2026-01-02"])
    items, cursor = repo.get_transactions_by_date_range("acct", None, None)
    assert [it["date"] for it in items] == ["2026-01-03", "2026-01-02", "2026-01-01"]
    assert cursor is None


def test_get_by_date_range_filters_between_two_dates(repo):
    _seed_dated(repo, "acct", ["2026-01-01", "2026-01-05", "2026-01-10"])
    items, _ = repo.get_transactions_by_date_range("acct", "2026-01-02", "2026-01-06")
    assert [it["date"] for it in items] == ["2026-01-05"]


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


# --------------------------------------------------------------------------- #
# update_transaction_category                                                 #
# --------------------------------------------------------------------------- #

def test_update_category_sets_value_and_returns_true(repo):
    key = ("ACCOUNT#acct", "TXN#t1")
    repo._table.store = {key: {"pk": key[0], "sk": key[1], "category": "OLD"}}
    assert repo.update_transaction_category(key[0], key[1], "GROCERIES") is True
    assert repo._table.store[key]["category"] == "GROCERIES"


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


def test_update_fields_clears_note_by_removing_the_attribute(repo):
    # A cleared note ("") must REMOVE the attribute so it reads back ABSENT, not "".
    key = ("ACCOUNT#acct", "TXN#t1")
    repo._table.store = {key: {"pk": key[0], "sk": key[1], "notes": "old note"}}
    assert repo.update_transaction_fields(key[0], key[1], notes="") is True
    assert "notes" not in repo._table.store[key]


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


def test_update_fields_clears_budget_excluded_false_by_removing(repo):
    # False must REMOVE the attribute so it reads back ABSENT (not stored False),
    # matching the sparse notes/tags clear — an absent override means "not excluded".
    key = ("ACCOUNT#acct", "TXN#t1")
    repo._table.store = {key: {"pk": key[0], "sk": key[1], "budget_excluded": True}}
    assert repo.update_transaction_fields(key[0], key[1], budget_excluded=False) is True
    assert "budget_excluded" not in repo._table.store[key]


def test_update_fields_with_no_fields_is_a_noop_without_writing(repo):
    # All fields _UNSET → nothing to write. It must NOT issue a (malformed) empty-
    # expression UpdateItem: returning True for a MISSING row proves the attribute_
    # exists guard was never reached (a real write would have returned False).
    assert repo.update_transaction_fields("ACCOUNT#x", "TXN#missing") is True


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


def test_update_fields_refuses_to_clear_category_on_falsy(repo):  # [A12]
    # category is set-only at the repo layer (WHIT-512), matching the PATCH API contract.
    # A falsy category must RAISE, not fall through the REMOVE branch and un-file the charge.
    # FAIL-ON-REVERT: drop the `field == "category" and not provided` guard and "" REMOVEs
    # the attribute -> the stored category disappears and this test goes red.
    key = ("ACCOUNT#acct", "TXN#t1")
    repo._table.store = {key: {"pk": key[0], "sk": key[1], "category": "GROCERIES", "notes": "n"}}
    with pytest.raises(ValueError):
        repo.update_transaction_fields(key[0], key[1], category="")
    row = repo._table.store[key]
    assert row["category"] == "GROCERIES"   # unchanged — the guard raised before any write
    assert row["notes"] == "n"


def test_update_fields_remove_only_omits_expression_attribute_values(repo, monkeypatch):  # [A13]
    # A REMOVE-only update (clear notes) must NOT send ExpressionAttributeValues —
    # DynamoDB rejects an UpdateItem carrying an empty values map. Capture the kwargs
    # the repo hands the table and assert the key is absent entirely. (category is
    # set-only per WHIT-512, so notes="" is the REMOVE-only vehicle here.)
    key = ("ACCOUNT#acct", "TXN#t1")
    repo._table.store = {key: {"pk": key[0], "sk": key[1], "notes": "X"}}
    captured = {}
    original = repo._table.update_item
    def spy(**kwargs):
        captured.update(kwargs)
        return original(**kwargs)
    monkeypatch.setattr(repo._table, "update_item", spy)

    assert repo.update_transaction_fields(key[0], key[1], notes="") is True
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

    assert updates[0]["ConditionExpression"] == "attribute_exists(pk) AND attribute_not_exists(#f0)"
    assert set(updates[0]["ExpressionAttributeValues"]) == {":v0"}


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


# --- WHIT-536 GAP: clear-by-hand and the tap-wins guard vs the stamp ---

def _seed_row(repo, **item):
    key = ("ACCOUNT#acct", "TXN#t1")
    repo._table.store = {key: {"pk": key[0], "sk": key[1], **item}}
    return key


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
    assert declared == {":v0", ":expected", ":v1"}
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


def test_refile_rule_fill_moves_category_and_rekeys_the_stamp(repo):
    # The edit-still-matches path: a charge the rule owns moves to the new target and the stamp is
    # re-keyed to the (possibly new) id. Here the text changed, so old id -> new id.
    key = _seed_row(repo, category="groceries", filed_by_rule="old-id", notes="keep")
    assert repo.refile_rule_fill(*key, "eatingout", "old-id", "new-id") is True
    row = repo._table.store[key]
    assert row["category"] == "eatingout"
    assert row["filed_by_rule"] == "new-id"
    assert row["notes"] == "keep"


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


# --------------------------------------------------------------------------- #
# WHIT-512 adversarial gaps (QA) — set-only category guard                     #
# --------------------------------------------------------------------------- #


def test_update_fields_falsy_category_raises_before_any_write(repo, monkeypatch):  # [B2]
    # ATOMICITY: a falsy category alongside a VALID notes must raise BEFORE the repo issues
    # any UpdateItem, so the notes are NOT partially written. Spy on the table: update_item
    # must never be called.
    # FAIL-ON-REVERT: drop the guard and the mixed call writes notes (and REMOVEs category),
    # so update_item fires and notes lands -> the "never called" + "notes absent" asserts go red.
    key = ("ACCOUNT#acct", "TXN#mix1")
    repo._table.store = {key: {"pk": key[0], "sk": key[1], "category": "GROCERIES"}}
    calls = []
    original = repo._table.update_item
    def spy(**kwargs):
        calls.append(kwargs)
        return original(**kwargs)
    monkeypatch.setattr(repo._table, "update_item", spy)

    with pytest.raises(ValueError):
        repo.update_transaction_fields(key[0], key[1], category="", notes="new note")

    assert calls == []                       # no UpdateItem issued at all
    row = repo._table.store[key]
    assert row["category"] == "GROCERIES"    # untouched
    assert "notes" not in row                # the valid field was NOT partially written


def test_update_fields_valid_category_set_with_notes_clear_in_one_write(repo):  # [B3]
    # The guard must NOT over-block: a VALID (truthy) category SET can still share one write
    # with a REMOVE (notes=""). Category is set, notes cleared, and the hand-file stamp removed
    # (category was touched). Guards the guard's scope — it only fires on a falsy category.
    # FAIL-ON-REVERT: broaden the guard to `field == "category"` (drop `and not provided`) and a
    # valid category SET starts raising -> this goes red.
    key = ("ACCOUNT#acct", "TXN#s1")
    repo._table.store = {key: {"pk": key[0], "sk": key[1], "category": "OLD",
                               "notes": "old note", "filed_by_rule": "rule-1"}}
    assert repo.update_transaction_fields(
        key[0], key[1], category="GROCERIES", notes="") is True
    row = repo._table.store[key]
    assert row["category"] == "GROCERIES"    # SET applied
    assert "notes" not in row                # REMOVE applied in the same write
    assert "filed_by_rule" not in row        # hand-file cleared the stamp


# --------------------------------------------------------------------------- #
# WHIT-607 — read_date_range_pages / read_window: the one "read every page"   #
# date-range read, bounded by a page limit                                    #
# --------------------------------------------------------------------------- #

def _seed_rows(repo, account_id, count, date="2026-01-10"):
    """Seed `count` rows on one account, all on the same date (unique ids)."""
    for i in range(count):
        tid = f"{account_id}-{i:04d}"
        repo._table.store[("ACCOUNT#" + account_id, "TXN#" + tid)] = {
            "pk": "ACCOUNT#" + account_id, "sk": "TXN#" + tid,
            "account_id": account_id, "transaction_id": tid, "date": date,
        }


def test_read_date_range_pages_follows_the_cursor_to_the_last_page(repo, shared):
    # 250 rows > MAX_PAGE_SIZE (100) → three pages, every row returned once.
    _seed_rows(repo, "up-spending", 250)
    rows = shared.repository.read_date_range_pages(
        repo, "up-spending", "2026-01-01", "2026-01-31"
    )
    ids = [r["transaction_id"] for r in rows]
    assert len(ids) == 250
    assert len(set(ids)) == 250
    assert repo._table.query_calls == 3


def test_read_date_range_pages_raises_loudly_at_the_page_limit(shared):
    # A cursor that never runs out must stop at max_pages with a clear error,
    # not spin until the server function times out.
    endless = _EndlessTransactionRepo(page=[{"transaction_id": "t1"}])
    with pytest.raises(RuntimeError, match="did not finish after 3 pages"):
        shared.repository.read_date_range_pages(
            endless, "up-spending", "2026-01-01", None, max_pages=3
        )
    assert len(endless.calls) == 3


def test_read_window_merges_every_mapped_account_within_the_range(repo, shared):
    _seed_rows(repo, "up-spending", 120, date="2026-01-10")
    _seed_rows(repo, "anz-rewards-black-visa", 2, date="2026-01-12")
    _seed_rows(repo, "westpac-altitude-qantas-black", 1, date="2026-02-20")  # out of range
    _seed_rows(repo, "not-a-mapped-account", 1, date="2026-01-10")  # never read

    rows = shared.repository.read_window(repo, "2026-01-01", "2026-01-31")
    by_account = {}
    for r in rows:
        by_account[r["account_id"]] = by_account.get(r["account_id"], 0) + 1
    assert by_account == {"up-spending": 120, "anz-rewards-black-visa": 2}


_GONE_PK, _GONE_SK = "ACCOUNT#acc", "TXN#gone"


@pytest.mark.parametrize("call", [
    pytest.param(lambda r: r.delete_transaction(_GONE_PK, _GONE_SK), id="delete_transaction"),
    pytest.param(lambda r: r.delete_if_still_pending(_GONE_PK, _GONE_SK), id="delete_if_still_pending"),
    pytest.param(lambda r: r.carry_onto_pending(_GONE_PK, _GONE_SK, {"category": "groceries"}),
                 id="carry_onto_pending"),
    pytest.param(lambda r: r.update_transaction_category(_GONE_PK, _GONE_SK, "groceries"),
                 id="update_transaction_category"),
    pytest.param(lambda r: r.clear_rule_fill(_GONE_PK, _GONE_SK, "rule-1"), id="clear_rule_fill"),
    pytest.param(lambda r: r.refile_rule_fill(_GONE_PK, _GONE_SK, "groceries", "rule-1", "rule-2"),
                 id="refile_rule_fill"),
    pytest.param(lambda r: r.update_transaction_fields(_GONE_PK, _GONE_SK, notes="hi"),
                 id="update_transaction_fields"),
])
def test_each_conditional_save_returns_false_when_the_row_is_gone(repo, call):
    assert call(repo) is False
