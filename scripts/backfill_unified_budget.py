#!/usr/bin/env python3
"""One-off migration: backfill the unified "Smoothing" mirror (buffer + payback_*) onto every
stored budget entry from its old rollover/spread fields (WHIT-548, slice 2 of the WHIT-546 epic).

Run on a laptop with the SAME AWS credentials `terraform apply` uses. Preview by default; pass
`--apply` to write.

    python scripts/backfill_unified_budget.py            # preview how many entries would change
    python scripts/backfill_unified_budget.py --apply    # write the mirror

Safe to run twice: the mirror is a pure function of the old fields, so a second run rebuilds an
identical map and writes nothing (no version bump). Balance-preserving: it only ADDS derived mirror
keys — no old field is touched, so every reader keeps seeing today's numbers. The read switch that
consumes the mirror is a later slice (WHIT-549).

Env (same as the deployed app_api Lambda): TABLE_NAME, AWS_REGION.
"""

import argparse
import pathlib
import sys


def _bootstrap_sys_path() -> None:
    """Put shared/ and lambda_api/ on the path, lambda_api FIRST — the same order prod uses, so a
    `from constants import ...` binds lambda_api/constants.py (the shadow), not shared/constants.py
    (AGENTS.md landmine)."""
    root = pathlib.Path(__file__).resolve().parents[1]
    for directory in (str(root / "shared"), str(root / "lambda_api")):
        while directory in sys.path:
            sys.path.remove(directory)
    sys.path.insert(0, str(root / "shared"))
    sys.path.insert(0, str(root / "lambda_api"))


_bootstrap_sys_path()

from repository_budget import BudgetRepository, _with_mirror  # noqa: E402  (after bootstrap)


def _preview(repo: BudgetRepository) -> int:
    """Count entries whose mirror would change, without writing."""
    entries = repo.list_budgets()
    return sum(1 for cat_id, entry in entries.items() if _with_mirror(entry) != entry)


def main() -> None:
    parser = argparse.ArgumentParser(description="Backfill the unified smoothing mirror onto budget entries.")
    parser.add_argument("--apply", action="store_true", help="write the mirror (default: preview only)")
    args = parser.parse_args()

    repo = BudgetRepository()
    if not args.apply:
        would_change = _preview(repo)
        print(f"preview: {would_change} budget entrie(s) would gain/refresh the unified mirror.")
        print("re-run with --apply to write.")
        return

    changed = repo.backfill_unified()
    print(f"applied: mirror written for {changed} budget entrie(s) (0 = already up to date).")


if __name__ == "__main__":
    main()
