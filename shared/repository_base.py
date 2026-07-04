"""Shared plumbing for the repository modules: DynamoDB table config (region +
table name read from the environment at import) and the common error-mapping
helper.

Split out of the formerly-monolithic repository.py so each repository class can
live in its own file while sharing one table configuration. Kept as a flat
top-level module (not a `repository/` package) on purpose — the shared layer is
staged with a non-recursive `cp shared/*.py` (terraform/layers.tf), which would
silently drop a package directory.
"""

import logging
import os
from typing import NoReturn

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
