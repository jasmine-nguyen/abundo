"""Shared plumbing for the repository modules: DynamoDB table config (region +
table name read from the environment at import), the common error-mapping
helper, and RepositoryBase — the lazy table connect and the 'read every page'
query loop every repository class inherits (WHIT-763).

Split out of the formerly-monolithic repository.py so each repository class can
live in its own file while sharing one table configuration.
"""

import logging
import os
from typing import Any, NoReturn

import boto3
from botocore.exceptions import ClientError

from repository_errors import DatabaseError

REGION_NAME = os.environ["AWS_REGION"]
TABLE_NAME = os.environ["TABLE_NAME"]

logger = logging.getLogger("repository")


def handle_database_error(e: ClientError, action: str) -> NoReturn:
    """Logs an AWS client error and re-raises it as a DatabaseError (WHIT-127)."""
    error_code = e.response["Error"]["Code"]
    error_message = e.response["Error"]["Message"]
    logger.error(f"DynamoDB Error [{error_code}]: {error_message}")
    raise DatabaseError(f"Database {action} failed: {error_message}") from e


class RepositoryBase:
    def __init__(self) -> None:
        self._dynamodb = None
        self._table = None

    def _get_table(self) -> Any:
        """Lazy-loads and buffers the connection to the physical DynamoDB table resource."""
        if self._table is None:
            self._dynamodb = boto3.resource("dynamodb", region_name=REGION_NAME)
            self._table = self._dynamodb.Table(TABLE_NAME)
        return self._table

    def _paginated_query(self, *, key_condition, filter_expression=None, action: str = "read") -> list[dict]:
        """Run a query to completion, following LastEvaluatedKey and accumulating every page.

        DynamoDB caps a query at 1MB per page and applies a FilterExpression AFTER that scan,
        per page — so reading only the first page would silently drop a matching row beyond it
        (WHIT-82). `filter_expression` is optional: a partition read that wants every row
        passes none, and it is omitted from the query entirely rather than sent as None.
        """
        try:
            items: list[dict] = []
            start_key = None
            while True:
                kwargs = {"KeyConditionExpression": key_condition}
                if filter_expression is not None:
                    kwargs["FilterExpression"] = filter_expression
                if start_key is not None:
                    kwargs["ExclusiveStartKey"] = start_key
                response = self._get_table().query(**kwargs)
                items.extend(response.get("Items", []))
                start_key = response.get("LastEvaluatedKey")
                if not start_key:
                    break
            return items
        except ClientError as e:
            handle_database_error(e, action)
