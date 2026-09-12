"""Gap tests for shared/repository_rule.py — WHIT-528.

Adversarial coverage the implementer's tests/shared/test_repository_rule.py does NOT reach:
  - ClientError -> DatabaseError on every public method (the ~81% coverage gap).
  - create_rule's `existing is None` race branch (refused put, then the row is gone).
  - update_rule in-place ConditionalCheckFailed -> RuleNotFoundError (deleted mid-edit).
  - update_rule move: new-row put ConditionalCheckFailed (concurrent create) -> RuleClashError,
    and the same put refused with the row then gone -> DatabaseError (not RuleClashError(None)).
  - list_rules empty table -> [].
  - sparse-field round-trip on the MOVE path (implementer only tested the metadata-present move).

No overlap with tests/shared/test_repository_rule.py. Uses the same `rule_repo` / `client_error`
/ `database_error` conftest fixtures.
"""

import pytest


def _make(rule_repo, value="COLES", category="groceries", field="description",
          operator="contains", **kwargs):
    return rule_repo.create_rule(field, operator, value, category, **kwargs)


# --- ClientError -> DatabaseError on every method (the coverage gap) -----------------------

def test_create_rule_non_conditional_client_error_becomes_database_error(
    rule_repo, client_error, database_error
):
    def boom(**kwargs):
        raise client_error("InternalServerError")
    rule_repo._table.put_item = boom
    with pytest.raises(database_error):
        _make(rule_repo)


def test_get_rule_client_error_becomes_database_error(rule_repo, client_error, database_error):
    def boom(**kwargs):
        raise client_error("ProvisionedThroughputExceededException")
    rule_repo._table.get_item = boom
    with pytest.raises(database_error):
        rule_repo.get_rule("deadbeefdeadbeef")


def test_list_rules_client_error_becomes_database_error(rule_repo, client_error, database_error):
    def boom(**kwargs):
        raise client_error("InternalServerError")
    rule_repo._table.query = boom
    with pytest.raises(database_error):
        rule_repo.list_rules()


def test_update_rule_read_client_error_becomes_database_error(
    rule_repo, client_error, database_error
):
    # The initial get_rule read inside update_rule fails -> DatabaseError propagates.
    def boom(**kwargs):
        raise client_error("InternalServerError")
    rule_repo._table.get_item = boom
    with pytest.raises(database_error):
        rule_repo.update_rule("deadbeefdeadbeef", "description", "contains", "COLES", "groceries")


def test_update_in_place_non_conditional_client_error_becomes_database_error(
    rule_repo, client_error, database_error
):
    original, _ = _make(rule_repo, value="COLES", category="groceries")

    def boom(**kwargs):
        raise client_error("InternalServerError")
    rule_repo._table.update_item = boom
    with pytest.raises(database_error):
        # same value -> same id -> in-place update path
        rule_repo.update_rule(original["id"], "description", "contains", "COLES", "coffee")


def test_update_move_new_put_non_conditional_client_error_becomes_database_error(
    rule_repo, client_error, database_error
):
    original, _ = _make(rule_repo, value="COLE")

    def boom(Item=None, ConditionExpression=None):
        raise client_error("InternalServerError")
    rule_repo._table.put_item = boom
    with pytest.raises(database_error):
        # different value -> different id -> move path -> put of new row fails hard
        rule_repo.update_rule(original["id"], "description", "contains", "COLES", "groceries")


def test_delete_rule_client_error_becomes_database_error(rule_repo, client_error, database_error):
    rule, _ = _make(rule_repo)

    def boom(**kwargs):
        raise client_error("InternalServerError")
    rule_repo._table.delete_item = boom
    with pytest.raises(database_error):
        rule_repo.delete_rule(rule["id"])


# --- race branches ------------------------------------------------------------------------

def test_create_rule_refused_but_row_gone_is_surfaced_as_database_error(
    rule_repo, client_error, database_error
):
    # The put is refused by attribute_not_exists(pk), but the read-back finds NOTHING (the row
    # vanished in the gap). This is a genuine race, not a clash: it must surface as a DB fault,
    # NOT as a RuleClashError and NOT as an AttributeError on `existing.get(...)`.
    def refuse(Item=None, ConditionExpression=None):
        raise client_error("ConditionalCheckFailedException")
    rule_repo._table.put_item = refuse   # store stays empty, so get_rule() -> None
    with pytest.raises(database_error):
        _make(rule_repo)


def test_update_in_place_conditional_check_failed_raises_not_found(rule_repo, client_error):
    # Row exists at the read, then is deleted before the conditional update_item lands:
    # attribute_exists(pk) fails -> RuleNotFoundError (not a silent success, not a DB fault).
    from repository_errors import RuleNotFoundError
    original, _ = _make(rule_repo, value="COLES", category="groceries")

    def refuse(**kwargs):
        raise client_error("ConditionalCheckFailedException")
    rule_repo._table.update_item = refuse
    with pytest.raises(RuleNotFoundError):
        rule_repo.update_rule(original["id"], "description", "contains", "COLES", "coffee")


def test_update_move_new_put_conditional_check_failed_raises_clash(rule_repo, client_error):
    # The move path checked get_rule(new_id) is None, then a CONCURRENT create landed the new_id
    # row before our put. The conditional put fails -> RuleClashError carrying the row that won.
    from repository_errors import RuleClashError
    original, _ = _make(rule_repo, value="COLE")

    def racing_put(Item=None, ConditionExpression=None):
        # simulate the concurrent writer landing between our check and our put
        rule_repo._table.store[(Item["pk"], Item["sk"])] = {**dict(Item), "category_id": "someone_else"}
        raise client_error("ConditionalCheckFailedException")
    rule_repo._table.put_item = racing_put

    with pytest.raises(RuleClashError) as excinfo:
        rule_repo.update_rule(original["id"], "description", "contains", "COLES", "groceries")
    assert excinfo.value.existing is not None
    assert excinfo.value.existing["category_id"] == "someone_else"
    # The old row was never touched (delete only runs after a successful put).
    assert rule_repo.get_rule(original["id"]) is not None


def test_update_move_new_put_refused_but_row_gone_is_surfaced_as_database_error(
    rule_repo, client_error, database_error
):
    # Move path: the conditional put is refused, but the read-back finds NOTHING (the racing row
    # vanished again). Like create_rule's analogue, this is a race, not a clash — it must surface
    # as a DB fault, never RuleClashError(None). Covers the `raced is None` guard on the move path.
    original, _ = _make(rule_repo, value="COLE")

    def refuse(Item=None, ConditionExpression=None):
        raise client_error("ConditionalCheckFailedException")   # store never gains new_id
    rule_repo._table.put_item = refuse
    with pytest.raises(database_error):
        rule_repo.update_rule(original["id"], "description", "contains", "COLES", "groceries")
    # The old row is untouched — the failed put never reached the delete.
    assert rule_repo.get_rule(original["id"]) is not None


# --- empty + sparse round-trips -----------------------------------------------------------

def test_list_rules_empty_table_returns_empty_list(rule_repo):
    assert rule_repo.list_rules() == []


def test_create_omits_falsy_import_metadata(rule_repo):
    # imported_at="" and banksync_enrichment_ids=[] are falsy -> omitted, not stored empty.
    rule, _ = _make(rule_repo, value="COLES", imported_at="", banksync_enrichment_ids=[])
    assert "imported_at" not in rule
    assert "banksync_enrichment_ids" not in rule
    assert rule_repo.get_rule(rule["id"]) == rule


def test_update_move_of_a_plain_rule_keeps_the_new_row_sparse(rule_repo):
    # Implementer only tested the move WITH import metadata. A plain app rule moved to free text
    # must NOT sprout empty imported_at / banksync_enrichment_ids on the new row.
    original, _ = _make(rule_repo, value="COLE")
    assert "imported_at" not in original and "banksync_enrichment_ids" not in original
    updated = rule_repo.update_rule(original["id"], "description", "contains", "COLES", "groceries")
    assert updated["id"] != original["id"]
    assert "imported_at" not in updated
    assert "banksync_enrichment_ids" not in updated
    assert rule_repo.get_rule(updated["id"]) == updated
    assert rule_repo.get_rule(original["id"]) is None


def test_update_in_place_carries_an_explicit_source(rule_repo):
    # in-place edit (same id) that also changes source -> the source alias branch fires and the
    # returned + stored row reflect it. Implementer only edited category in place.
    original, _ = _make(rule_repo, value="COLES", category="groceries", source="app")
    updated = rule_repo.update_rule(
        original["id"], "description", "contains", "COLES", "coffee", source="import"
    )
    assert updated["source"] == "import"
    assert updated["category_id"] == "coffee"
    assert rule_repo.get_rule(original["id"])["source"] == "import"
