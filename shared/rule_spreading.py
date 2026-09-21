"""Seed a category's bill-spread plan when a `spread` rule files a matching charge (WHIT-559).

The webhook (lambda/rule_ingest.py) and the "Apply my rules" sweep (lambda_api/handler.py) both file
charges, and both must auto-spread a bill the SAME way — so the side-effect lives here, in one shared
place, exactly as the categorisation itself lives once in rule_engine. Kept a flat top-level module
(staged by the non-recursive `cp shared/*.py`), constants-free at import (the cadence→cycles bounds
come through spend.cadence_cycles), and takes its repos as arguments so the webhook's
TransactionRepository subclass wiring is untouched.

Behaviour: a rule marked `spread` that has not yet seeded its plan creates the category's spread ONCE
via the create-only `set_spread_if_absent`, then flips `spread_seeded` so it never re-seeds — even
after the user deletes the plan ("stay dismissed"). Create-only + the seeded gate make it safe to run
per charge on every webhook and every sweep pass. Best-effort: a failure reading the pay cycle or
writing the plan is logged and swallowed, never breaking the charge filing that triggered it (a later
charge or sweep retries).
"""

import logging

from spend import cadence_cycles, current_cycle_window

logger = logging.getLogger(__name__)


class SpreadSeeder:
    """Seeds spread rules' plans across one filing run, reading the pay cycle at most once.

    One instance per webhook delivery / sweep run. `seed(rule)` is a no-op for a non-spread or
    already-seeded rule and for a rule already handled this run, so a normal charge — and a spread
    rule matching 500 charges — costs at most one pay-cycle read + one budget write. `rule` is the
    engine-shaped dict (camelCase: id, categoryId, spread, spreadSeeded, spreadAmount, spreadGapDays).
    """

    def __init__(self, budget_repo, paycycle_repo, rule_repo) -> None:
        self._budget_repo = budget_repo
        self._paycycle_repo = paycycle_repo
        self._rule_repo = rule_repo
        self._cycle = None            # the pay cycle, read lazily on the first real seed
        self._handled: set = set()    # rule ids seeded (or attempted) this run — per-run dedup

    def seed(self, rule: dict) -> None:
        if not rule or not rule.get("spread") or rule.get("spreadSeeded"):
            return
        rule_id = rule.get("id")
        if rule_id in self._handled:
            return
        self._handled.add(rule_id)
        try:
            if self._cycle is None:
                self._cycle = self._paycycle_repo.get_paycycle()
            cycle_start, _ = current_cycle_window(self._cycle["last_pay_date"], self._cycle["length"])
            cycles = cadence_cycles(rule["spreadGapDays"], self._cycle["length"])
            created = self._budget_repo.set_spread_if_absent(
                rule["categoryId"], rule["spreadAmount"], cycles,
                cycle_start, self._cycle["length"], self._cycle["last_pay_date"])
            if created is not None:
                self._rule_repo.mark_spread_seeded(rule_id)
        except Exception:
            logger.exception("spread seed failed for rule %s (ignored)", rule_id)
