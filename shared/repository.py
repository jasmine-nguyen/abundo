"""Facade re-exporting the repository classes and error types, now split one-per-file.

Import sites keep using `from repository import X` unchanged; the implementations
live in repository_<x>.py, with shared plumbing (RepositoryBase) in repository_base
and the exceptions in repository_errors. Helpers are imported from their own module.
"""

from repository_errors import (
    CategoryNotFoundError,
    DatabaseError,
    DuplicateCategoryError,
    InvalidCategoryParentError,
    RuleClashError,
    RuleNotFoundError,
    VersionConflictError,
)
from repository_transaction import TransactionRepository
from repository_category import CategoryRepository
from repository_budget import BudgetRepository
from repository_goals import GoalsRepository
from repository_paycycle import PayCycleRepository
from repository_balance import AccountBalanceRepository, FeedWatchRepository
from repository_loanfacts import LoanFactsRepository
from repository_milestone import MilestoneRepository
from repository_device import DeviceRepository
from repository_insight import InsightRepository
from repository_rule import RuleRepository
from repository_job import JobRepository

__all__ = [
    "TransactionRepository",
    "CategoryRepository",
    "RuleRepository",
    "JobRepository",
    "BudgetRepository",
    "GoalsRepository",
    "PayCycleRepository",
    "AccountBalanceRepository",
    "FeedWatchRepository",
    "LoanFactsRepository",
    "MilestoneRepository",
    "DeviceRepository",
    "InsightRepository",
    "DuplicateCategoryError",
    "CategoryNotFoundError",
    "InvalidCategoryParentError",
    "RuleClashError",
    "RuleNotFoundError",
    "VersionConflictError",
    "DatabaseError",
]
