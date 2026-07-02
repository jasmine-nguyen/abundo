"""Repository exceptions, shared across the config-item repositories. The handler
maps each to an HTTP status (see lambda_api/handler.py)."""


class DuplicateCategoryError(Exception):
    """A category with the given id already exists (handler maps this to 409)."""


class CategoryNotFoundError(Exception):
    """No category with the given id exists (handler maps this to 404)."""


class VersionConflictError(Exception):
    """A config-item write could not converge within its retry budget because a
    concurrent writer kept moving the optimistic-lock version (handler maps this
    to 409). Shared by every single-config-item repository."""
