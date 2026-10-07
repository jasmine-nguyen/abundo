"""The user's rule book (WHIT-623) — the one place a saved rule row becomes the matcher's shape.

The webhook (lambda/rule_ingest.py), the API routes and the apply-rules worker all read rules
through `rule_from_row`, so they can never drift apart on which fields reach the matcher.
`rule_reply` is the same rule as the app sees it (without the internal `spreadSeeded` flag).

`RuleBook` is the user's rule book for one run: read once, then file incoming charges (webhook),
sweep stored ones (the apply-rules route and worker), or re-file after an edit/delete.

Banksync-free at import: the write limits come in as arguments and the whole-history read is
imported lazily.
"""

import copy
import logging
import time
from typing import Callable

import rule_engine
from repository_errors import DatabaseError

logger = logging.getLogger(__name__)


def rule_from_row(row: dict) -> dict:
    """A stored rule row (repository_rule, snake_case) in the engine's shape (camelCase)."""
    return {
        "id": row.get("id"),
        "field": row.get("field"),
        "operator": row.get("operator"),
        "value": row.get("value"),
        "categoryId": row.get("category_id"),
        "budgetExcluded": bool(row.get("budget_excluded")),
        # WHIT-559: the spread action, whether its plan was already created, and the captured bill.
        "spread": bool(row.get("spread")),
        "spreadSeeded": bool(row.get("spread_seeded")),
        "spreadAmount": row.get("spread_amount"),
        "spreadGapDays": row.get("spread_gap_days"),
        # WHIT-541: None on a single-condition rule; the engine then reads field/operator/value.
        "conditions": row.get("conditions"),
        "logic": row.get("logic"),
    }


def rule_reply(rule: dict) -> dict:
    """An engine-shaped rule as the app receives it — `spreadSeeded` is internal bookkeeping."""
    return {key: value for key, value in rule.items() if key != "spreadSeeded"}


class WriteLimit:
    """How much writing one run may do: at most `max_writes` attempts, and no new write once
    `time_budget` seconds have passed since `started`, read off `clock` (the same clock `started`
    came from). `WriteLimit.none()` is uncapped (the worker)."""

    def __init__(self, max_writes: int | None, time_budget: float | None, started: float | None,
                 clock: Callable[[], float]):
        self.max_writes = max_writes
        self.time_budget = time_budget
        self.started = started
        self.clock = clock

    @classmethod
    def none(cls) -> "WriteLimit":
        return cls(None, None, None, time.monotonic)

    def reached(self, attempted: int) -> bool:
        if self.max_writes is not None and attempted >= self.max_writes:
            return True
        # `attempted and` guarantees at least one write, so a slow read or a long scan can never
        # starve a run into zero progress.
        if self.time_budget is None or not attempted:
            return False
        return self.clock() - self.started >= self.time_budget


class RuleBook:
    """The user's rules + taxonomy for one run, read once, in the engine's shape.

    `target_by_id`, `excluded_by_id` and `spread_by_id` always cover the WHOLE store — `only()`
    narrows `rules` to one inline rule but keeps them, so the reconcile sweep can still tell an
    orphaned stamp (rule gone) from a drifted one (rule still here, charge off its target)."""

    def __init__(self, taxonomy_ids, rule_rows: list[dict]):
        self.taxonomy_ids = set(taxonomy_ids)
        self.rules = [rule_from_row(row) for row in rule_rows]
        self.target_by_id = {rule["id"]: rule["categoryId"] for rule in self.rules if rule["id"]}
        self.excluded_by_id = {rule["id"]: rule["budgetExcluded"] for rule in self.rules if rule["id"]}
        self.spread_by_id = {rule["id"]: rule for rule in self.rules if rule["spread"] and rule["id"]}

    @classmethod
    def load(cls, rule_repo, category_repo) -> "RuleBook":
        """Read the taxonomy then the rules. A read failure raises; the caller decides what that means."""
        taxonomy_ids = {category["id"] for category in category_repo.list_categories()}
        return cls(taxonomy_ids, rule_repo.list_rules())

    def is_unfiled(self, category: str | None) -> bool:
        return rule_engine.is_unfiled_category(category, self.taxonomy_ids)

    def applicable(self) -> list[dict]:
        """The rules the engine would act on — unsupported, category-less and deleted-category
        rules dropped — so `decide` can read each one's categoryId directly."""
        return [rule for rule in self.rules if rule_engine._skip_reason(rule, self.is_unfiled) is None]

    def only(self, inline_rule: dict, *, field: str, operator: str) -> "RuleBook":
        """This book narrowed to the inline "file this shop" rule (WHIT-523), keeping the
        whole-store lookups. Its id is None: it is minted after planning, so the sweep stamps it."""
        narrowed = copy.copy(self)
        narrowed.rules = [{
            "id": None,
            "field": field,
            "operator": operator,
            "value": inline_rule["value"],
            "categoryId": inline_rule["categoryId"],
        }]
        return narrowed

    def plan(self, transactions: list[dict]) -> dict:
        """What this book's rules would do to `transactions` — decided, not done."""
        return rule_engine.plan_rule_application(self.rules, transactions, self.is_unfiled)

    def file_charges(self, rows: list[dict], seeder=None, *, counts_to_budget) -> None:
        """File each unfiled charge in `rows` in place, when exactly one live category is agreed.

        Disagreeing rules leave it unfiled (both ids logged); no match leaves it unchanged. A filed
        charge gets the winning rule's stamp (WHIT-536), its "keep out of budget" action (WHIT-558,
        only ever set True), a recomputed `counts_to_budget(account_id, category)`, and — through
        `seeder` — its spread plan (WHIT-559)."""
        applicable = self.applicable()
        if not applicable:
            return
        for charge in rows:
            self._file_charge(charge, applicable, seeder, counts_to_budget)

    def _file_charge(self, charge: dict, applicable: list[dict], seeder, counts_to_budget) -> None:
        if not self.is_unfiled(charge.get("category")):
            return
        resolved, matched_indices, categories = rule_engine.decide(applicable, charge)
        if not categories:
            return
        if resolved is None:
            logger.info(
                "rule ingest: %s left unfiled — matching rules disagree %s",
                charge.get("transaction_id"),
                sorted({applicable[index]["id"] for index in matched_indices}),
            )
            return
        winning_rule = applicable[matched_indices[0]]
        charge["category"] = resolved
        charge["counts_to_budget"] = counts_to_budget(charge["account_id"], resolved)
        charge["filed_by_rule"] = winning_rule["id"]
        if winning_rule.get("budgetExcluded"):
            charge["budget_excluded"] = True
        if seeder is not None:
            seeder.seed(winning_rule)
        logger.info("rule ingest: filed %s -> %s (rule %s)",
                    charge.get("transaction_id"), resolved, winning_rule["id"])

    def sweep(
        self, transaction_repo, transactions: list[dict], plan: dict, *,
        limit: WriteLimit, inline_stamp: str | None = None, inline_excluded: bool = False,
        run_reconcile: bool, seeder=None, on_progress: Callable[[dict], None] | None = None,
    ) -> tuple[list[dict], list[str], list[str], list[str], int]:
        """The write half of apply-rules (WHIT-537): file `plan["matched"]`, then — only when
        `run_reconcile` (the plain full sweep, never the inline path) — the WHIT-540 reconcile pass.
        Both share ONE `attempted` count and ONE `limit`, so the primary filing is never starved.

        An inline run (plan rule_id None) stamps `inline_stamp` / `inline_excluded` on every row;
        the plain sweep reads both off the winning rule. `on_progress` gets the running counts after
        each write. Returns (filed, vanished, failed, already_filed, matched_remaining)."""
        filed: list[dict] = []
        vanished: list[str] = []
        failed: list[str] = []
        already_filed: list[str] = []
        attempted = 0  # counts ATTEMPTS, not successes — it bounds the work this run does

        def emit_progress() -> None:
            if on_progress is not None:
                on_progress({
                    "filed": len(filed), "vanished": len(vanished), "failed": len(failed),
                    "alreadyFiled": len(already_filed), "attempted": attempted,
                })

        for transaction, category_id, rule_id in plan["matched"]:
            if limit.reached(attempted):
                break
            transaction_id = transaction.get("transaction_id")
            attempted += 1
            if inline_stamp is not None:
                stamp, budget_excluded = inline_stamp, inline_excluded
            else:
                stamp, budget_excluded = rule_id, self.excluded_by_id.get(rule_id, False)
            # Once per run and create-only, whether or not the write below lands (WHIT-559).
            if seeder is not None and self.spread_by_id:
                seeder.seed(self.spread_by_id.get(rule_id))
            try:
                # Conditional on the category the SCAN saw, so the user's tap always beats a rule (WHIT-508).
                status, current_category = transaction_repo.update_transaction_category_if_unchanged(
                    transaction["pk"], transaction["sk"], category_id, transaction.get("category"),
                    filed_by_rule=stamp, budget_excluded=budget_excluded,
                )
            except DatabaseError:
                failed.append(transaction_id)
                emit_progress()
                continue
            if status == "written":
                filed.append({"id": transaction_id, "category": category_id})
            elif status == "gone":
                vanished.append(transaction_id)
            # It changed underneath: a tap files it (leave it), but a re-sync carrying the bank's
            # raw label back leaves it unfiled, which must not be reported as filed.
            elif self.is_unfiled(current_category):
                failed.append(transaction_id)
            else:
                already_filed.append(transaction_id)
            emit_progress()

        # Only the file loop's unreached matches — captured BEFORE the reconcile pass shares `attempted`.
        matched_remaining = len(plan["matched"]) - attempted

        # WHIT-540 reconcile: undo a stamp whose rule is gone; move a stamped charge that sits off its
        # live rule's target back onto it. The stamp guards make each write a no-op if the user has
        # since taken the charge over.
        if run_reconcile:
            for transaction in transactions:
                if limit.reached(attempted):
                    break
                stamp = transaction.get("filed_by_rule")
                if not stamp:
                    continue
                target = self.target_by_id.get(stamp)
                try:
                    if target is None:
                        attempted += 1
                        transaction_repo.clear_rule_fill(transaction["pk"], transaction["sk"], stamp)
                        emit_progress()
                    elif not self.is_unfiled(target) and transaction.get("category") != target:
                        attempted += 1
                        transaction_repo.refile_rule_fill(
                            transaction["pk"], transaction["sk"], target, stamp, stamp)
                        emit_progress()
                except DatabaseError:
                    # Best-effort cleanup — a later sweep retries the tail.
                    continue

        return filed, vanished, failed, already_filed, matched_remaining

    @staticmethod
    def refile_touched(old_rule_id: str, edited_rule: dict | None, transaction_repo,
                       limit: WriteLimit) -> int:
        """Re-file or undo the stored charges `old_rule_id` already filed, after that rule is edited
        or deleted (WHIT-540). Returns how many it did NOT reach within `limit`.

          * delete (edited_rule None) — clear each back to unfiled.
          * a material edit (the id moved) of a rule that can be re-run on a filed charge
            (reevaluatable_after_fill) — re-file the charges it still matches, clear the rest.
          * any other edit (in place, or a rule matching on `category`) — re-file all of them to the
            new target without re-evaluating: re-running could only wrongly drop a charge.

        The tail beyond `limit` is finished by the next "Apply my rules" reconcile pass."""
        from repository_transaction import read_window

        touched = [transaction for transaction in read_window(transaction_repo, None, None)
                   if transaction.get("filed_by_rule") == old_rule_id]
        reevaluate = (
            edited_rule is not None
            and edited_rule.get("id") != old_rule_id
            and rule_engine.reevaluatable_after_fill(edited_rule)
        )

        attempted = 0
        for transaction in touched:
            if limit.reached(attempted):
                break
            attempted += 1
            pk, sk = transaction["pk"], transaction["sk"]
            try:
                if edited_rule is None:
                    transaction_repo.clear_rule_fill(pk, sk, old_rule_id)
                elif not reevaluate or rule_engine.rule_matches(edited_rule, transaction):
                    transaction_repo.refile_rule_fill(
                        pk, sk, edited_rule["categoryId"], old_rule_id, edited_rule["id"])
                else:
                    transaction_repo.clear_rule_fill(pk, sk, old_rule_id)
            except DatabaseError:
                # Best-effort: the reconcile pass or the next edit finishes this row.
                continue

        return len(touched) - attempted
