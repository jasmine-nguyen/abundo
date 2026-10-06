"""Shared plumbing for the repository modules: DynamoDB table config (region +
table name read from the environment at import), the common error-mapping
helpers (db_errors wraps every plain read/write), and RepositoryBase — the lazy
table connect, the 'read every page' query loop and the settings-record steps
(read, create-if-missing, save with a version check retried once) every
repository class inherits (WHIT-763).

Split out of the formerly-monolithic repository.py so each repository class can
live in its own file while sharing one table configuration.
"""

import logging
import os
from contextlib import contextmanager
from decimal import Decimal
from typing import Any, Callable, Iterator, NoReturn, Optional

import boto3
from botocore.exceptions import ClientError

from repository_errors import DatabaseError, VersionConflictError

REGION_NAME = os.environ["AWS_REGION"]
TABLE_NAME = os.environ["TABLE_NAME"]

logger = logging.getLogger("repository")


def handle_database_error(e: ClientError, action: str) -> NoReturn:
    """Logs an AWS client error and re-raises it as a DatabaseError (WHIT-127)."""
    error_code = e.response["Error"]["Code"]
    error_message = e.response["Error"]["Message"]
    logger.error(f"DynamoDB Error [{error_code}]: {error_message}")
    raise DatabaseError(f"Database {action} failed: {error_message}") from e


@contextmanager
def db_errors(action: str) -> Iterator[None]:
    """Re-raises any AWS client error inside the block as a DatabaseError for `action`."""
    try:
        yield
    except ClientError as e:
        handle_database_error(e, action)


def set_map_entry(entry_id: str, value: Any) -> dict:
    """The versioned update that writes ONE whole entry of a config item's `items` map."""
    return {"expression": "SET #items.#id = :val, #v = :next",
            "names": {"#items": "items", "#id": entry_id},
            "values": {":val": value}}


def remove_map_entry(entry_id: str) -> dict:
    """The versioned update that drops ONE key from a config item's `items` map."""
    return {"expression": "REMOVE #items.#id SET #v = :next",
            "names": {"#items": "items", "#id": entry_id}}


class RepositoryBase:
    # Settings stores (one config item holding a map + a version) set these.
    _config_key: dict = {}
    _config_label: str = ""

    def __init__(self) -> None:
        self._table = None

    def _get_table(self) -> Any:
        """Lazy-loads and buffers the connection to the physical DynamoDB table resource."""
        if self._table is None:
            self._table = boto3.resource("dynamodb", region_name=REGION_NAME).Table(TABLE_NAME)
        return self._table

    def _paginated_query(self, *, key_condition, filter_expression=None, action: str = "read") -> list[dict]:
        """Run a query to completion, following LastEvaluatedKey and accumulating every page.

        DynamoDB caps a query at 1MB per page and applies a FilterExpression AFTER that scan,
        per page — so reading only the first page would silently drop a matching row beyond it
        (WHIT-82). `filter_expression` is optional: a partition read that wants every row
        passes none, and it is omitted from the query entirely rather than sent as None.
        """
        with db_errors(action):
            items: list[dict] = []
            kwargs = {"KeyConditionExpression": key_condition}
            if filter_expression is not None:
                kwargs["FilterExpression"] = filter_expression
            while True:
                response = self._get_table().query(**kwargs)
                items.extend(response.get("Items", []))
                start_key = response.get("LastEvaluatedKey")
                if not start_key:
                    return items
                kwargs["ExclusiveStartKey"] = start_key

    def _seed_fields(self) -> dict:
        """The fields a freshly created config item starts with (besides key and version)."""
        return {"items": {}}

    def _get_config(self) -> Optional[dict]:
        with db_errors(f"read {self._config_label}"):
            return self._get_table().get_item(Key=self._config_key).get("Item")

    def _ensure_seeded(self) -> None:
        """Idempotently create the config item if absent. A lost race (another caller seeded
        first) raises ConditionalCheckFailed and is a no-op success."""
        try:
            self._get_table().put_item(
                Item={**self._config_key, **self._seed_fields(), "version": Decimal(1)},
                ConditionExpression="attribute_not_exists(pk)",
            )
        except ClientError as e:
            if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return
            handle_database_error(e, f"seed {self._config_label}")

    def _versioned_update(self, build: Callable[[Optional[dict]], Optional[tuple]], *, action: str,
                          seed: bool = True, on_conflict: Optional[Callable[[], None]] = None) -> Any:
        """Read the config item, let `build(item)` plan the write, and save it under the
        optimistic-lock guard, retrying once on a version race.

        `build` runs against the fresh item on every attempt and returns None (nothing to
        write — no version bump) or `(update, result)`: `update` holds the "expression"
        (which must SET `#v = :next`), its "names", optional "values" and an optional extra
        "condition"; `result` is returned once the write lands. `on_conflict` runs after each
        lost race (e.g. to re-read and raise a precise error). Raises VersionConflictError
        if it can't converge.
        """
        if seed:
            self._ensure_seeded()
        for _attempt in range(2):
            item = self._get_config()
            plan = build(item)
            if plan is None:
                return None
            update, result = plan
            version = item["version"]
            condition = "attribute_exists(pk) AND #v = :expected"
            if "condition" in update:
                condition += " AND " + update["condition"]
            try:
                self._get_table().update_item(
                    Key=self._config_key,
                    UpdateExpression=update["expression"],
                    ConditionExpression=condition,
                    ExpressionAttributeNames={**update["names"], "#v": "version"},
                    ExpressionAttributeValues={
                        **update.get("values", {}),
                        ":expected": version,
                        ":next": version + Decimal(1),
                    },
                )
                return result
            except ClientError as e:
                if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
                    handle_database_error(e, action)
                if on_conflict:
                    on_conflict()
        raise VersionConflictError(f"{action}: exhausted retries under write contention")
