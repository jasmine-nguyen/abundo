"""Tests for the WHIT-532 import-script methods on shared/repository_rule.py:
``create_rule(now=)``, ``stamp_import``, the guarded ``delete_rule``, and the import ledger.

Run against the real conftest FakeTable (via the ``rule_repo`` fixture), so the conditional
writes, the REMOVE-on-empty, and the optimistic-lock guard are exercised for real. The script's
diff logic is tested in tests/scripts; here we pin only the storage primitives it builds on.
"""

import pytest


def _make(rule_repo, value="COLES", category="groceries", field="description",
          operator="contains", **kwargs):
    return rule_repo.create_rule(field, operator, value, category, **kwargs)


# --- create_rule(now=) --------------------------------------------------------


def test_create_with_now_stamps_all_three_timestamps_equal(rule_repo):
    # The "untouched since import" signal: a freshly imported row reads created==updated==imported.
    rule, _ = _make(rule_repo, source="import", imported_at="2026-01-01T00:00:00Z",
                    now="2026-01-01T00:00:00Z")
    assert rule["created_at"] == "2026-01-01T00:00:00Z"
    assert rule["updated_at"] == "2026-01-01T00:00:00Z"
    assert rule["imported_at"] == "2026-01-01T00:00:00Z"


def test_create_without_now_still_stamps_wall_clock(rule_repo):
    # FAIL-ON-REVERT for `now or _now()`: drop the wall-clock fallback and this row has no stamp.
    rule, _ = _make(rule_repo)
    assert rule["created_at"] and rule["updated_at"] == rule["created_at"]
    assert "imported_at" not in rule            # app rows carry no import metadata


# --- stamp_import -------------------------------------------------------------


def test_stamp_import_sets_imported_and_updated_together(rule_repo):
    rule, _ = _make(rule_repo, source="import", imported_at="T1", now="T1")
    rule_repo.stamp_import(rule["id"], stamp="T2")
    row = rule_repo.get_rule(rule["id"])
    assert row["updated_at"] == "T2" and row["imported_at"] == "T2"


def test_stamp_import_sets_category_and_sorts_dedupes_ids(rule_repo):
    rule, _ = _make(rule_repo, source="import", imported_at="T1", now="T1")
    rule_repo.stamp_import(rule["id"], stamp="T2", category_id="petrol",
                           banksync_enrichment_ids=["e2", "e1", "e2"])
    row = rule_repo.get_rule(rule["id"])
    assert row["category_id"] == "petrol"
    assert row["banksync_enrichment_ids"] == ["e1", "e2"]   # sorted + deduped


def test_stamp_import_empty_id_list_removes_the_attribute(rule_repo):
    rule, _ = _make(rule_repo, source="import", imported_at="T1", now="T1",
                    banksync_enrichment_ids=["e1"])
    rule_repo.stamp_import(rule["id"], stamp="T2", banksync_enrichment_ids=[])
    row = rule_repo.get_rule(rule["id"])
    assert "banksync_enrichment_ids" not in row            # cleared reads back ABSENT, not []


def test_stamp_import_set_imported_at_false_leaves_app_row_metadata_free(rule_repo):
    rule, _ = _make(rule_repo)                             # source=app, no imported_at
    rule_repo.stamp_import(rule["id"], stamp="T2", banksync_enrichment_ids=["e1"],
                           set_imported_at=False)
    row = rule_repo.get_rule(rule["id"])
    assert "imported_at" not in row                        # app row never grows import metadata
    assert row["updated_at"] == "T2" and row["banksync_enrichment_ids"] == ["e1"]


def test_stamp_import_set_imported_at_false_keeps_a_touched_rows_old_imported_at(rule_repo):
    rule, _ = _make(rule_repo, source="import", imported_at="T1", now="T1")
    rule_repo.stamp_import(rule["id"], stamp="T3", set_imported_at=False)
    row = rule_repo.get_rule(rule["id"])
    assert row["imported_at"] == "T1" and row["updated_at"] == "T3"   # stays "touched"


def test_stamp_import_expected_mismatch_raises_conflict_and_writes_nothing(rule_repo):
    from repository_errors import VersionConflictError
    rule, _ = _make(rule_repo, source="import", imported_at="T1", now="T1")
    with pytest.raises(VersionConflictError):
        rule_repo.stamp_import(rule["id"], stamp="T2", category_id="petrol",
                               expected_updated_at="STALE")
    row = rule_repo.get_rule(rule["id"])
    assert row["category_id"] == "groceries" and row["updated_at"] == "T1"   # untouched


def test_stamp_import_expected_match_applies(rule_repo):
    rule, _ = _make(rule_repo, source="import", imported_at="T1", now="T1")
    rule_repo.stamp_import(rule["id"], stamp="T2", category_id="petrol",
                           expected_updated_at="T1")
    assert rule_repo.get_rule(rule["id"])["category_id"] == "petrol"


def test_stamp_import_absent_row_raises_not_found(rule_repo):
    from repository_errors import RuleNotFoundError
    with pytest.raises(RuleNotFoundError):
        rule_repo.stamp_import("deadbeefdeadbeef", stamp="T2")


def test_stamp_import_non_conditional_client_error_becomes_database_error(
    rule_repo, client_error, database_error
):
    rule, _ = _make(rule_repo, source="import", imported_at="T1", now="T1")

    def boom(**kwargs):
        raise client_error("InternalServerError")
    rule_repo._table.update_item = boom
    with pytest.raises(database_error):
        rule_repo.stamp_import(rule["id"], stamp="T2")


# --- delete_rule(expected_updated_at=) ----------------------------------------


def test_guarded_delete_match_removes_the_row(rule_repo):
    rule, _ = _make(rule_repo, source="import", imported_at="T1", now="T1")
    rule_repo.delete_rule(rule["id"], expected_updated_at="T1")
    assert rule_repo.get_rule(rule["id"]) is None


def test_guarded_delete_mismatch_raises_conflict_and_keeps_the_row(rule_repo):
    from repository_errors import VersionConflictError
    rule, _ = _make(rule_repo, source="import", imported_at="T1", now="T1")
    with pytest.raises(VersionConflictError):
        rule_repo.delete_rule(rule["id"], expected_updated_at="STALE")
    assert rule_repo.get_rule(rule["id"]) is not None


def test_guarded_delete_absent_row_raises_not_found(rule_repo):
    from repository_errors import RuleNotFoundError
    with pytest.raises(RuleNotFoundError):
        rule_repo.delete_rule("deadbeefdeadbeef", expected_updated_at="T1")


def test_unguarded_delete_calls_delete_item_with_key_only(rule_repo):
    # The app's delete stays a bare no-op-on-missing call; the recording stub asserts no
    # ConditionExpression rides along on the unguarded path.
    rule, _ = _make(rule_repo)
    seen = {}

    def record(Key, **kwargs):
        seen["Key"] = Key
        seen["kwargs"] = kwargs
    rule_repo._table.delete_item = record
    rule_repo.delete_rule(rule["id"])
    assert seen["Key"] == {"pk": "RULE", "sk": f"RULE#{rule['id']}"}
    assert seen["kwargs"] == {}


# --- the import ledger --------------------------------------------------------


def test_ledger_empty_when_never_written(rule_repo):
    assert rule_repo.get_import_ledger() == {}


def test_ledger_add_then_read_round_trips(rule_repo):
    rule_repo.add_to_import_ledger({"e1": "rid1", "e2": "rid2"}, stamp="T1")
    assert rule_repo.get_import_ledger() == {"e1": "rid1", "e2": "rid2"}


def test_ledger_add_twice_merges(rule_repo):
    rule_repo.add_to_import_ledger({"e1": "rid1"}, stamp="T1")
    rule_repo.add_to_import_ledger({"e2": "rid2"}, stamp="T2")
    assert rule_repo.get_import_ledger() == {"e1": "rid1", "e2": "rid2"}


def test_ledger_add_empty_writes_nothing(rule_repo):
    # FAIL-ON-REVERT for the "rerun is a true no-op" guarantee: an empty add must not touch the
    # table at all (no ledger row springs into being, no updated_at bump).
    before = {k: dict(v) for k, v in rule_repo._table.store.items()}
    rule_repo.add_to_import_ledger({}, stamp="T1")
    assert rule_repo._table.store == before


def test_ledger_never_appears_as_a_rule(rule_repo):
    # The ledger lives under pk=RULE_IMPORT, so list_rules (Query on pk=RULE) never returns it.
    _make(rule_repo)
    rule_repo.add_to_import_ledger({"e1": "rid1"}, stamp="T1")
    assert all(row["pk"] == "RULE" for row in rule_repo.list_rules())
    assert len(rule_repo.list_rules()) == 1


def test_ledger_read_client_error_becomes_database_error(rule_repo, client_error, database_error):
    def boom(**kwargs):
        raise client_error("InternalServerError")
    rule_repo._table.get_item = boom
    with pytest.raises(database_error):
        rule_repo.get_import_ledger()


def test_ledger_write_client_error_becomes_database_error(rule_repo, client_error, database_error):
    def boom(**kwargs):
        raise client_error("InternalServerError")
    rule_repo._table.update_item = boom
    with pytest.raises(database_error):
        rule_repo.add_to_import_ledger({"e1": "rid1"}, stamp="T1")
