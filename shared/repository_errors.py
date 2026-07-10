"""Repository exceptions, shared across the config-item repositories. The handler
maps each to an HTTP status (see lambda_api/handler.py)."""


class DuplicateCategoryError(Exception):
    """A category with the given id already exists (handler maps this to 409)."""


class CategoryNotFoundError(Exception):
    """No category with the given id exists (handler maps this to 404)."""


class InvalidCategoryParentError(Exception):
    """A requested parent link is invalid — the parent id is unknown, is the
    category itself, sits in a different bucket, or would close a cycle (handler
    maps this to 400). The message states which rule was broken."""


class VersionConflictError(Exception):
    """A config-item write could not converge within its retry budget because a
    concurrent writer kept moving the optimistic-lock version (handler maps this
    to 409). Shared by every single-config-item repository."""


class DatabaseError(Exception):
    """A DynamoDB operation failed — raised by handle_database_error, chaining the
    underlying botocore ClientError as its cause.

    Deliberately a distinct type and NOT a RuntimeError (WHIT-127): an
    `except DatabaseError` catches real DB faults without also swallowing an
    unrelated RuntimeError from a logic bug. An uncaught DatabaseError still
    surfaces as a Lambda 500, the same as the bare RuntimeError it replaced."""
