"""Apply the user's own categorisation rules to charges as they arrive (WHIT-530).

BankSync used to label every charge at sync time, before it reached us. Once rules live in our
own store (WHIT-526), our server must do that labelling itself. This is the webhook-side twin of
the "Apply my rules" sweep (lambda_api.apply_rules_to_uncategorized): both decide a charge's
category through the SAME shared rule_engine, so incoming and stored-history filing can never
diverge. No provenance stamp yet — that is WHIT-536.

Best-effort on the READ: a failure reading the rules or taxonomy is caught, so every charge lands
unfiled (the sweep catches up). The per-charge filing itself is not wrapped — but a charge that
reached here came through `normalise`, which always sets `account_id`, so the recompute can't fault
on real traffic. Only unfiled charges are touched; one agreed live category is set, disagreeing
rules leave the charge unfiled, and a rule to a deleted category is skipped.

Not a method on the transaction store — a plain function taking the stores as arguments (the same
shape as budget_alerts.capture_pre_write), so the WHIT-454 subclass wiring stays untouched. Imports
no shared `constants`; rule_book (and the rule_engine it wraps) is constants-free.
"""

import logging
from typing import Callable, Optional

from rule_book import RuleBook
from spend import counts_to_budget

logger = logging.getLogger(__name__)


def load_rules(rule_repo, category_repo):
    """Read the user's rule book once and return `(book, is_unfiled)` ready to file charges, or
    None if the read failed (the caller then leaves charges unfiled). Splitting the read from the
    filing lets a per-row caller (reprocess) read once, not once per charge."""
    try:
        book = RuleBook.load(rule_repo, category_repo)
    except Exception:
        logger.exception("rule ingest: could not read rules/taxonomy; charges land unfiled")
        return None
    return book, book.is_unfiled


def file_charge(charge: dict, book: RuleBook, _is_unfiled=None, *, seeder=None) -> None:
    """File one charge in place by `book` (see RuleBook.file_charges). The unused middle argument
    keeps `file_charge(charge, *load_rules(...))` working for reprocess."""
    book.file_charges([charge], seeder, counts_to_budget=counts_to_budget)


def apply(rows: list, *, rule_repo, category_repo,
          budget_repo=None, paycycle_repo=None) -> tuple[list, Optional[Callable]]:
    """File each unfiled charge in `rows` by the user's rules, in place, and return
    `(rows, is_unfiled)`.

    `is_unfiled` is the taxonomy check the reconcile carry needs (WHIT-545) so a stored raw
    category can't clobber a rule-fill on settlement. It is None when no rules/taxonomy were
    read — a data-less delivery or a read failure — in which case the caller leaves the carry
    unchanged.

    When `budget_repo` + `paycycle_repo` are supplied (the live webhook does; reprocess does not),
    a spread rule filing a matching charge auto-creates the category's spread plan (WHIT-559),
    seeded once per delivery via a shared SpreadSeeder. Omit them to skip spreading.

    Reads the rules + taxonomy once for the whole batch. A read failure leaves every charge
    unfiled (still lands, logged). An empty rule store is a no-op — the rows are returned
    untouched."""
    if not rows:
        return rows, None                # a data-less delivery (summary event) pays for no reads
    loaded = load_rules(rule_repo, category_repo)
    if loaded is None:
        return rows, None
    book, is_unfiled = loaded
    seeder = None
    if budget_repo is not None and paycycle_repo is not None:
        # Lazy import keeps THIS module's load constants-free (its docstring invariant): rule_spreading
        # -> spend -> constants, which must not be pulled at rule_ingest import time.
        from rule_spreading import SpreadSeeder
        seeder = SpreadSeeder(budget_repo, paycycle_repo, rule_repo)
    book.file_charges(rows, seeder, counts_to_budget=counts_to_budget)
    return rows, is_unfiled
