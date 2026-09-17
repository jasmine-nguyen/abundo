"""WHIT-559 — QA gap tests for the smooth->spread rule-row migration.

Complements the 14 existing tests (A1-A7, G1-G7). Covers:
  Q1 — non-conditional ClientError re-raises (apply must not swallow unexpected errors)
  Q2 — _RENAMES mapping is exactly the 4 known pairs (regression guard)
  Q3 — REMOVE-only apply on an existing row returns True (migrated count)
  Q4 — plan_row with an unrelated-only row (no smooth*/spread* keys) returns None
"""

import sys

import pytest

from _dynamo_fakes import FakeTable
from _migration_spread_fakes import migration, seed, row


@pytest.fixture
def table():
    return FakeTable()


def test_apply_reraises_non_conditional_client_error(table):
    # [Q1] If DynamoDB returns an error OTHER than ConditionalCheckFailedException
    # (e.g. ProvisionedThroughputExceededException), apply() must let it propagate.
    # FAIL-ON-REVERT: broadening the except to `except ClientError: return False` swallows it.
    seed(table, "RULE#r1", smooth=True, smooth_seeded=False)

    ClientError = sys.modules["botocore.exceptions"].ClientError

    def exploding_update(**kwargs):
        err = ClientError()
        err.response = {"Error": {"Code": "ProvisionedThroughputExceededException",
                                   "Message": "Rate exceeded"}}
        raise err

    table.update_item = exploding_update

    with pytest.raises(ClientError) as exc_info:
        migration.apply(table, "RULE#r1", {"spread": True}, ["smooth"])

    assert exc_info.value.response["Error"]["Code"] == "ProvisionedThroughputExceededException"


def test_renames_mapping_covers_all_known_fields():
    # [Q2] The migration must rename exactly these 4 old attributes. A missing entry
    # leaves an old field silently un-renamed; a spurious entry renames the wrong thing.
    # FAIL-ON-REVERT: deleting any entry from _RENAMES breaks this.
    assert migration._RENAMES == {
        "smooth": "spread",
        "smooth_amount": "spread_amount",
        "smooth_gap_days": "spread_gap_days",
        "smooth_seeded": "spread_seeded",
    }


def test_remove_only_apply_returns_true_on_existing_row(table):
    # [Q3] G4 proved REMOVE-only omits ExpressionAttributeValues and lands correct state,
    # but never checked apply()'s return value. A False here would under-report migrated count.
    # FAIL-ON-REVERT: `if not values: return False` before the try block breaks this.
    seed(table, "RULE#r1", smooth=True, spread=True,
         smooth_seeded=False, spread_seeded=True)

    plan = migration.plan_row(row(table, "RULE#r1"))
    set_map, remove = plan
    assert set_map == {}

    assert migration.apply(table, "RULE#r1", set_map, remove) is True


def test_plan_row_none_for_row_with_only_unrelated_keys():
    # [Q4] A row with only standard fields and NO smooth*/spread* keys. Subtly different
    # from A7 (which has spread* present). plan_row must return None, not ({}, []).
    # FAIL-ON-REVERT: returning ({}, []) would make apply() build an empty UpdateExpression.
    r = {"pk": "RULE", "sk": "RULE#bare", "field": "description",
         "operator": "contains", "value": "NETFLIX", "category_id": "entertainment"}
    assert migration.plan_row(r) is None
