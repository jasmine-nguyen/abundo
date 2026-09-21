"""Async "Apply my rules over all history" worker (WHIT-537).

The synchronous POST /transactions/uncategorized/apply-rules caps itself at 300 writes / 15s to
stay inside the 30s API Gateway window, so a large history takes repeated "apply the rest" taps.
This worker runs the SAME sweep with NO cap: the app's POST .../apply-rules/jobs creates a job
row and async-invokes this function; it files every matched charge, writes its progress to the
job row as it goes, and marks the row succeeded/failed at the end. The app polls GET .../jobs/{id}.

It lives in the lambda_api bundle (not the webhook bundle) because the whole sweep — the
whole-history read, the rule planning, the shared write phase, and the APPLY_RULES_* handling — is
lambda_api code. It reuses those handler helpers rather than re-deriving them, so the sync route
and the worker can never drift on WHAT gets filed; only the cap differs (a call-site parameter).
"""

import logging

from constants import DEFAULT_RULE_FIELD, DEFAULT_RULE_OPERATOR
from handler import (
    _apply_rules_write_phase,
    _as_leaf_rule,
    _build_rule_spread_map,
    _fetch_windowed_transactions,
    _rule_to_client,
)
from repository import (
    BudgetRepository,
    CategoryRepository,
    DatabaseError,
    JobRepository,
    PayCycleRepository,
    RuleClashError,
    RuleRepository,
    TransactionRepository,
)
from rule_spreading import SpreadSeeder
from repository_job import STATUS_FAILED, STATUS_SUCCEEDED
from rule_engine import is_unfiled_category, plan_rule_application

logger = logging.getLogger(__name__)

# Persist progress to the job row after this many charges are filed, so the app's progress bar
# moves without one DynamoDB write per charge on a multi-thousand-row sweep.
PROGRESS_EVERY = 50


def _zero_counts() -> dict:
    return {"matched": 0, "attempted": 0, "filed": 0, "vanished": 0,
            "failed": 0, "alreadyFiled": 0, "remaining": 0}


def lambda_handler(event: dict, context=None) -> dict:
    """Run the uncapped apply-rules sweep for one job.

    Event shape (from start_apply_rules_job's async invoke):
      {"jobId": "<id>"}                                   — sweep ALL the user's rules.
      {"jobId": "<id>", "rule": {"value", "categoryId"}}  — mint that rule and sweep with only it.
    """
    job_id = event["jobId"]
    inline_rule = event.get("rule")

    transaction_repo = TransactionRepository()
    category_repo = CategoryRepository()
    rule_repo = RuleRepository()
    job_repo = JobRepository()
    budget_repo = BudgetRepository()
    paycycle_repo = PayCycleRepository()

    created_rule = None
    try:
        taxonomy_ids = {category["id"] for category in category_repo.list_categories()}

        def is_unfiled(category):
            return is_unfiled_category(category, taxonomy_ids)

        raw_rules = rule_repo.list_rules()
        rules = [_rule_to_client(row) for row in raw_rules]
        # Captured BEFORE the inline path narrows `rules`: the reconcile sweep needs the WHOLE
        # store to tell an orphaned stamp (rule gone) from a drifted one (rule still here), and the
        # plain sweep reads each winning rule's "keep out of budget" action from here (WHIT-558).
        rule_target_by_id = {rule["id"]: rule["categoryId"] for rule in rules if rule.get("id")}
        rule_excluded_by_id = {
            rule["id"]: bool(rule.get("budgetExcluded")) for rule in rules if rule.get("id")}
        # The spread context (WHIT-559) — from the raw rows, since it needs spread_seeded.
        rule_spread_by_id = _build_rule_spread_map(raw_rules)

        if inline_rule is not None:
            # File ONLY this shop: mint the rule (idempotent, WHIT-497) then sweep with just it.
            # The POST already refused a clash; a same-text/different-category race here raises.
            row, _created = rule_repo.create_rule(
                DEFAULT_RULE_FIELD, DEFAULT_RULE_OPERATOR,
                inline_rule["value"], inline_rule["categoryId"],
                budget_excluded=inline_rule["budgetExcluded"],
            )
            created_rule = _rule_to_client(row)
            rules = [_as_leaf_rule(inline_rule)]

        if not rules:
            job_repo.finish_job(job_id, STATUS_SUCCEEDED, _zero_counts(), created_rule=created_rule)
            return {"jobId": job_id, "status": STATUS_SUCCEEDED}

        transactions = _fetch_windowed_transactions(transaction_repo, None, None)
        plan = plan_rule_application(rules, transactions, is_unfiled)
        matched_total = len(plan["matched"])
        job_repo.update_progress(job_id, {**_zero_counts(), "matched": matched_total,
                                          "remaining": matched_total})

        progressed = {"filed_at_last_write": 0}

        def on_progress(counts):
            # Track by charges FILED (the file loop's outcomes), not `attempted` — attempted also
            # climbs through the invisible reconcile sweep, which would make the bar overshoot.
            done = (counts["filed"] + counts["vanished"]
                    + counts["failed"] + counts["alreadyFiled"])
            if done and done - progressed["filed_at_last_write"] >= PROGRESS_EVERY:
                progressed["filed_at_last_write"] = done
                job_repo.update_progress(job_id, {
                    "matched": matched_total, "attempted": done,
                    "filed": counts["filed"], "vanished": counts["vanished"],
                    "failed": counts["failed"], "alreadyFiled": counts["alreadyFiled"],
                    "remaining": matched_total - done,
                })

        filed, vanished, failed, already_filed, matched_remaining = _apply_rules_write_phase(
            transaction_repo, plan, transactions, rule_target_by_id, rule_excluded_by_id, is_unfiled,
            inline_stamp=(created_rule["id"] if inline_rule is not None else None),
            inline_excluded=(inline_rule["budgetExcluded"] if inline_rule is not None else False),
            run_reconcile=(inline_rule is None),
            rule_spread_by_id=rule_spread_by_id,
            spread_seeder=SpreadSeeder(budget_repo, paycycle_repo, rule_repo),
            max_writes=None, time_budget=None, on_progress=on_progress,
        )

        counts = {
            "matched": matched_total,
            "attempted": len(filed) + len(vanished) + len(failed) + len(already_filed),
            "filed": len(filed), "vanished": len(vanished),
            "failed": len(failed), "alreadyFiled": len(already_filed),
            "remaining": matched_remaining,
        }
        job_repo.finish_job(job_id, STATUS_SUCCEEDED, counts, created_rule=created_rule)
        return {"jobId": job_id, "status": STATUS_SUCCEEDED}
    except Exception as e:
        # Any failure (a DB fault, a rule clash race) marks the job failed with the message, so a
        # poll sees it end rather than hang at "running" until the row's TTL. The sweep is
        # re-run-safe (tap-wins writes, idempotent create_rule), so the user can just start again.
        logger.error("apply-rules worker failed for job %s: %s", job_id, e)
        error = "a rule for that already exists" if isinstance(e, RuleClashError) else str(e)
        try:
            job_repo.finish_job(job_id, STATUS_FAILED, {}, created_rule=created_rule, error=error)
        except DatabaseError:
            logger.error("apply-rules worker could not mark job %s failed", job_id)
        return {"jobId": job_id, "status": STATUS_FAILED}
