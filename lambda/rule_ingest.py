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
no shared `constants` (the lambda_api/constants.py shadow landmine); rule_engine is constants-free.
"""

import logging
from typing import Callable, Optional

from banksync import counts_to_budget
import rule_engine

logger = logging.getLogger(__name__)


def _to_engine_rule(row: dict) -> dict:
    """Map a stored rule row (repository_rule, snake_case `category_id`) to the engine's Rule
    shape (`categoryId`). Mirrors lambda_api/handler._rule_to_client so the webhook and the API
    decide identically."""
    return {
        "id": row.get("id"),
        "field": row.get("field"),
        "operator": row.get("operator"),
        "value": row.get("value"),
        "categoryId": row.get("category_id"),
        "budgetExcluded": bool(row.get("budget_excluded")),
        # WHIT-559: the spread action + the bill it captured, carried so file_charge can auto-create
        # the category's spread plan on a match. A non-spread rule has spread False and no amount/gap.
        "spread": bool(row.get("spread")),
        "spreadSeeded": bool(row.get("spread_seeded")),
        "spreadAmount": row.get("spread_amount"),
        "spreadGapDays": row.get("spread_gap_days"),
        # WHIT-541: a multi-condition rule carries these; the engine reads them, else falls back to
        # the flat field/operator/value. None for a single-condition rule.
        "conditions": row.get("conditions"),
        "logic": row.get("logic"),
    }


def load_rules(rule_repo, category_repo):
    """Read the user's rules + taxonomy once and return `(applicable_rules, is_unfiled)` ready to
    file charges, or None if the read failed (the caller then leaves charges unfiled). Splitting
    the read from the filing lets a per-row caller (reprocess) read once, not once per charge.

    `applicable_rules` are the store rules mapped to the engine shape and filtered through
    `rule_engine._skip_reason` — dropping unsupported, category-less and deleted-category
    rules — so `decide` can read each one's categoryId directly."""
    try:
        taxonomy_ids = {category["id"] for category in category_repo.list_categories()}
        rules = [_to_engine_rule(row) for row in rule_repo.list_rules()]
    except Exception:
        logger.exception("rule ingest: could not read rules/taxonomy; charges land unfiled")
        return None

    def is_unfiled(category):
        return rule_engine.is_unfiled_category(category, taxonomy_ids)

    applicable = [rule for rule in rules if rule_engine._skip_reason(rule, is_unfiled) is None]
    return applicable, is_unfiled


def file_charge(charge: dict, applicable_rules: list, is_unfiled, *, seeder=None) -> None:
    """File one charge in place, if it is unfiled and exactly one live category is agreed.

    Disagreeing rules leave it unfiled (both ids logged); no match leaves it unchanged. When a
    rule files it, the SPENDING flag is recomputed from the new category (counts_to_budget), so a
    charge filed into a non-budget category stops counting. `seeder` (a shared SpreadSeeder, when the
    caller supplies the budget/paycycle/rule repos) auto-creates the category's spread plan if the
    winning rule is a spread one (WHIT-559)."""
    if not applicable_rules:
        return
    if not is_unfiled(charge.get("category")):
        return
    resolved, matched_indices, categories = rule_engine.decide(applicable_rules, charge)
    if not categories:
        return
    if resolved is None:
        logger.info(
            "rule ingest: %s left unfiled — matching rules disagree %s",
            charge.get("transaction_id"),
            sorted({applicable_rules[index]["id"] for index in matched_indices}),
        )
        return
    charge["category"] = resolved
    charge["counts_to_budget"] = counts_to_budget(charge["account_id"], resolved)
    winning_rule = applicable_rules[matched_indices[0]]
    # Remember which rule filed it (WHIT-536), so history can always explain the category.
    charge["filed_by_rule"] = winning_rule["id"]
    # Keep it out of the budget too, if the winning rule says so (WHIT-558). Only ever SET True —
    # never write False — so the charge stays sparse and a later hand-set exclusion is untouched.
    if winning_rule.get("budgetExcluded"):
        charge["budget_excluded"] = True
    # Auto-spread the bill, if the winning rule says so (WHIT-559). Best-effort + create-only, so it
    # never breaks filing and seeds the plan at most once.
    if seeder is not None:
        seeder.seed(winning_rule)
    logger.info(
        "rule ingest: filed %s -> %s (rule %s)",
        charge.get("transaction_id"), resolved, applicable_rules[matched_indices[0]]["id"],
    )


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
    applicable_rules, is_unfiled = loaded
    seeder = None
    if budget_repo is not None and paycycle_repo is not None:
        # Lazy import keeps THIS module's load constants-free (its docstring invariant): rule_spreading
        # -> spend -> constants, which must not be pulled at rule_ingest import time.
        from rule_spreading import SpreadSeeder
        seeder = SpreadSeeder(budget_repo, paycycle_repo, rule_repo)
    for charge in rows:
        file_charge(charge, applicable_rules, is_unfiled, seeder=seeder)
    return rows, is_unfiled
