"""Async "Apply my rules over all history" worker (WHIT-537).

The synchronous POST /transactions/uncategorized/apply-rules caps itself at 300 writes / 15s to
stay inside the 30s API Gateway window, so a large history takes repeated "apply the rest" taps.
This worker runs the SAME sweep with NO cap: the app's POST .../apply-rules/jobs creates a job
row and async-invokes this function; it files every matched charge, writes its progress to the
job row as it goes, and marks the row succeeded/failed at the end. The app polls GET .../jobs/{id}.

It lives in the lambda_api bundle (not the webhook bundle) because the APPLY_RULES_* handling and the
job row are lambda_api code. The sweep itself is the shared RuleBook (WHIT-623), the same one the
sync route runs, so the two can never drift on WHAT gets filed; only the write limit differs.
"""

import logging

from api_constants import DEFAULT_RULE_FIELD, DEFAULT_RULE_OPERATOR
from repository_budget import BudgetRepository
from repository_category import CategoryRepository
from repository_errors import DatabaseError, RuleClashError
from repository_paycycle import PayCycleRepository
from repository_rule import RuleRepository
from repository_job import STATUS_FAILED, STATUS_SUCCEEDED, JobRepository
from repository_transaction import TransactionRepository, read_window
from rule_book import RuleBook, WriteLimit, rule_from_row, rule_reply
from rule_spreading import SpreadSeeder

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
        book = RuleBook.load(rule_repo, category_repo)
        if inline_rule is not None:
            # File ONLY this shop: mint the rule (idempotent, WHIT-497) then sweep with just it.
            # The POST already refused a clash; a same-text/different-category race here raises.
            row, _created = rule_repo.create_rule(
                DEFAULT_RULE_FIELD, DEFAULT_RULE_OPERATOR,
                inline_rule["value"], inline_rule["categoryId"],
                budget_excluded=inline_rule["budgetExcluded"],
            )
            created_rule = rule_reply(rule_from_row(row))
            book = book.only(inline_rule, field=DEFAULT_RULE_FIELD, operator=DEFAULT_RULE_OPERATOR)

        if not book.rules:
            job_repo.finish_job(job_id, STATUS_SUCCEEDED, _zero_counts(), created_rule=created_rule)
            return {"jobId": job_id, "status": STATUS_SUCCEEDED}

        transactions = read_window(transaction_repo, None, None)
        plan = book.plan(transactions)
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

        filed, vanished, failed, already_filed, matched_remaining = book.sweep(
            transaction_repo, transactions, plan,
            limit=WriteLimit.none(),
            inline_stamp=(created_rule["id"] if inline_rule is not None else None),
            inline_excluded=(inline_rule["budgetExcluded"] if inline_rule is not None else False),
            run_reconcile=(inline_rule is None),
            seeder=SpreadSeeder(budget_repo, paycycle_repo, rule_repo),
            on_progress=on_progress,
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
