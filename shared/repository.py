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
    DatabaseError,
    DuplicateCategoryError,
    InvalidCategoryParentError,
    VersionConflictError,
)
from repository_transaction import TransactionRepository, sanitise_transaction
from repository_category import (
    CATEGORY_PALETTE,
    SEED_CATEGORIES,
    CategoryRepository,
    color_slot_counts,
    color_slot_plan_order,
    least_held_color_slot,
    plan_color_slot_backfill,
    plan_color_slot_repaint,
    plan_new_category_slot,
    plan_color_slot_stage,
    validate_category_depth,
    validate_category_parent,
)
from repository_budget import BudgetRepository
from repository_goals import GoalsRepository
from repository_paycycle import PayCycleRepository
from repository_balance import AccountBalanceRepository, HomeLoanBalanceRepository
from repository_loanfacts import LoanFactsRepository
from repository_milestone import MilestoneRepository
from repository_device import DeviceRepository
from repository_insight import InsightRepository

__all__ = [
    "TransactionRepository",
    "CategoryRepository",
    "BudgetRepository",
    "GoalsRepository",
    "PayCycleRepository",
    "HomeLoanBalanceRepository",
    "AccountBalanceRepository",
    "LoanFactsRepository",
    "MilestoneRepository",
    "DeviceRepository",
    "InsightRepository",
    "DuplicateCategoryError",
    "CategoryNotFoundError",
    "InvalidCategoryParentError",
    "VersionConflictError",
    "DatabaseError",
    "SEED_CATEGORIES",
    "CATEGORY_PALETTE",
    "validate_category_parent",
    "validate_category_depth",
    "color_slot_counts",
    "least_held_color_slot",
    "plan_color_slot_backfill",
    "plan_color_slot_repaint",
    "plan_new_category_slot",
    "plan_color_slot_stage",
    "color_slot_plan_order",
    "sanitise_transaction",
    "handle_database_error",
]
