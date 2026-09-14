"""In-memory DynamoDB table stand-in, shared across the repository suites (WHIT-532).

Lifted verbatim out of ``tests/shared/conftest.py`` (``FakeTable`` + ``_client_error``) so it
can be imported by BASENAME — ``pythonpath = tests/shared`` (pytest.ini) puts this dir on the
path — from a sibling suite that isn't the shared conftest's own. The import-script suite
(``tests/scripts/``) needs it to drive the REAL ``RuleRepository`` against a fake table, which is
the only way its "an app text edit does not resurrect the old rule" case is fail-on-revert.

``conftest.py`` re-imports both names from here, so its fixtures and the ``conftest.FakeTable``
attribute are unchanged. Keep this dependency-light: ``_client_error`` resolves botocore lazily
through ``sys.modules`` (the boto stubs install it), so importing this module pulls in no
shared/-layer module and no real boto3/botocore.
"""

import sys


def _client_error(code: str, message: str = "boom"):
    """Build a botocore-shaped ClientError the repository's handlers can inspect."""
    err = sys.modules["botocore.exceptions"].ClientError()
    err.response = {"Error": {"Code": code, "Message": message}}
    return err


class FakeTable:
    """In-memory DynamoDB table stand-in, injected via ``repo._table``. Emulates the
    calls the shared TransactionRepository makes: batch_writer put, conditional
    put_item / update_item, and query with KeyConditionExpression + FilterExpression
    (evaluated via _Predicate), newest-first ordering, Limit and cursor pagination.
    """

    def __init__(self):
        self.store: dict = {}  # (pk, sk) -> item
        self.query_calls = 0
        self.get_item_calls = 0
        self.consistent_reads: list = []

    def batch_writer(self):
        store = self.store

        class _Batch:
            def __enter__(self_):
                return self_

            def __exit__(self_, *exc):
                return False

            def put_item(self_, Item):
                store[(Item["pk"], Item["sk"])] = dict(Item)

        return _Batch()

    def put_item(self, Item, ConditionExpression=None):
        key = (Item["pk"], Item["sk"])
        # Same strictness as update_item below: an unrecognised condition must not pass silently,
        # or a drifted expression string leaves the guard dead with every test still green.
        if ConditionExpression not in (None, "attribute_not_exists(pk)"):
            raise AssertionError(f"FakeTable does not know ConditionExpression {ConditionExpression!r}")
        if ConditionExpression == "attribute_not_exists(pk)" and key in self.store:
            raise _client_error("ConditionalCheckFailedException")
        self.store[key] = dict(Item)

    def get_item(self, Key, ConsistentRead=False):
        self.get_item_calls += 1
        self.consistent_reads.append(ConsistentRead)
        item = self.store.get((Key["pk"], Key["sk"]))
        return {"Item": dict(item)} if item is not None else {}

    def _condition_holds(self, key, ConditionExpression, values):
        """Evaluate the condition strings the shared TransactionRepository actually builds.

        An UNRECOGNISED expression raises rather than falling through: the old code silently
        ignored one, so a drifted condition string would leave every conditional test green with
        the guard dead — and the setdefault below would invent the row it was meant to protect.
        """
        item = self.store.get(key)
        if ConditionExpression == "attribute_exists(pk)":
            return item is not None
        if ConditionExpression == "attribute_exists(pk) AND attribute_not_exists(#c)":
            return item is not None and "category" not in item
        if ConditionExpression == "attribute_exists(pk) AND #c = :expected":
            return item is not None and item.get("category") == values[":expected"]
        raise AssertionError(f"FakeTable does not know ConditionExpression {ConditionExpression!r}")

    def update_item(self, Key, UpdateExpression, ExpressionAttributeNames,
                    ExpressionAttributeValues=None, ConditionExpression=None):
        key = (Key["pk"], Key["sk"])
        values = ExpressionAttributeValues or {}
        if ConditionExpression is not None and not self._condition_holds(
            key, ConditionExpression, values
        ):
            raise _client_error("ConditionalCheckFailedException")
        item = self.store.setdefault(key, {"pk": Key["pk"], "sk": Key["sk"]})
        # The repository builds "SET ... [REMOVE ...]" — either clause optional, and SET may
        # assign several comma-separated pairs (e.g. update_transaction_category's
        # "SET #c = :category REMOVE #p", or the rule-stamp "SET #c = :category, #p = :rule").
        # SET assigns each aliased name = value; REMOVE deletes each aliased attribute, so a
        # cleared field reads back ABSENT (not ""/[]). ExpressionAttributeValues is
        # omitted for a REMOVE-only update, matching real DynamoDB.
        set_part, _, remove_part = UpdateExpression.strip().partition("REMOVE")
        set_part = set_part.strip()
        if set_part.startswith("SET"):
            for pair in set_part[len("SET"):].split(","):
                if not pair.strip():
                    continue
                name_alias, value_alias = (part.strip() for part in pair.split("="))
                item[ExpressionAttributeNames[name_alias]] = values[value_alias]
        for name_alias in remove_part.split(","):
            name_alias = name_alias.strip()
            if name_alias:
                item.pop(ExpressionAttributeNames[name_alias], None)

    def delete_item(self, Key, ConditionExpression=None,
                    ExpressionAttributeNames=None, ExpressionAttributeValues=None):
        # pop(..., None) makes a delete of a missing key a no-op, so delete-twice both succeed.
        # WHIT-532 added a guarded delete (stamp check); evaluate it via the same _condition_holds
        # so an unrecognised condition still raises rather than passing silently.
        key = (Key["pk"], Key["sk"])
        if ConditionExpression is not None:
            if not self._condition_holds(key, ConditionExpression, ExpressionAttributeValues or {}):
                raise _client_error("ConditionalCheckFailedException")
        self.store.pop(key, None)

    def query(self, KeyConditionExpression=None, FilterExpression=None,
              ScanIndexForward=None, Limit=None, IndexName=None,
              ExclusiveStartKey=None):
        self.query_calls += 1
        items = list(self.store.values())
        if KeyConditionExpression is not None:
            items = [it for it in items if KeyConditionExpression.evaluate(it)]
        if FilterExpression is not None:
            items = [it for it in items if FilterExpression.evaluate(it)]

        # date-index reads sort by date; ScanIndexForward=False → newest first.
        items.sort(
            key=lambda it: (it.get("date", ""), it.get("sk", "")),
            reverse=ScanIndexForward is False,
        )

        if ExclusiveStartKey is not None:
            after = (ExclusiveStartKey["pk"], ExclusiveStartKey["sk"])
            for i, it in enumerate(items):
                if (it["pk"], it["sk"]) == after:
                    items = items[i + 1:]
                    break

        result: dict = {}
        if Limit is not None and len(items) > Limit:
            page = items[:Limit]
            last = page[-1]
            result["LastEvaluatedKey"] = {"pk": last["pk"], "sk": last["sk"]}
        else:
            page = items
        result["Items"] = [dict(it) for it in page]
        return result
