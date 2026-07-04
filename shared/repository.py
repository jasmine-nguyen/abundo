"""Facade re-exporting the repository classes, now split one-per-file.

Import sites keep using `from repository import X` unchanged; the implementations
live in repository_transaction / repository_category / repository_budget /
repository_paycycle, with shared plumbing in repository_base and the exceptions in
repository_errors.

Deliberately a flat set of top-level modules, NOT a `repository/` package: the
shared Lambda layer is staged with a non-recursive `cp shared/*.py`
(terraform/layers.tf), which would silently drop a package directory from the
layer and 500 every route at import — the exact outage class this service has
been bitten by before.
"""

from repository_base import handle_database_error
from repository_errors import (
    CategoryNotFoundError,
    DuplicateCategoryError,
    VersionConflictError,
)
from repository_transaction import TransactionRepository, sanitise_transaction
from repository_category import (
    CATEGORY_PALETTE,
    SEED_CATEGORIES,
    CategoryRepository,
)
from repository_budget import BudgetRepository
from repository_paycycle import PayCycleRepository
from repository_balance import HomeLoanBalanceRepository
from repository_loanfacts import LoanFactsRepository

__all__ = [
    "TransactionRepository",
    "CategoryRepository",
    "BudgetRepository",
    "PayCycleRepository",
    "HomeLoanBalanceRepository",
    "LoanFactsRepository",
    "DuplicateCategoryError",
    "CategoryNotFoundError",
    "VersionConflictError",
    "SEED_CATEGORIES",
    "CATEGORY_PALETTE",
    "sanitise_transaction",
    "handle_database_error",
]
