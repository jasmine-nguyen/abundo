"""One-off rebuild (WHIT-742): fill in the past cycles behind each rollover budget's carryover.

Live seals save each cycle from WHIT-742 on; a carryover folded before that has no cycles behind
it. For each rollover budget, this walks back cycle by cycle from the oldest saved cycle (or from
`carryover_from` when none are saved) and recomputes each cycle from today's saved transactions at
today's target, with the same per-cycle maths the live seal uses. It keeps the 1..N most recent
cycles whose sum comes closest to the unexplained part of the carryover (ties to fewer cycles),
flags them `rebuilt`, and appends them after the saved ones. Any gap left shows in the app as
"Not matched to a cycle". Nothing is written when no list beats the gap alone.

Safe to run twice: a budget that already has rebuilt cycles is skipped. Dry run by default — pass
--apply to save. Each write is conditional on the budgets item's version not having moved since
the read, so a budget changed meanwhile is skipped (re-run to pick it up).
Set TABLE_NAME / AWS_REGION below (or via env), have AWS creds in the environment, then run."""

import os
import pathlib
import sys
from datetime import date, timedelta
from decimal import Decimal

os.environ.setdefault("TABLE_NAME", "abundo-dynamodb-table")
os.environ.setdefault("AWS_REGION", "ap-southeast-2")

_SHARED_DIR = str(pathlib.Path(__file__).resolve().parents[2] / "shared")
if _SHARED_DIR not in sys.path:
    sys.path.insert(0, _SHARED_DIR)

import boto3  # noqa: E402
from botocore.exceptions import ClientError  # noqa: E402

from constants import ROLLOVER_HISTORY_MAX_CYCLES  # noqa: E402
from repository_category import CategoryRepository  # noqa: E402
from repository_transaction import TransactionRepository, read_window  # noqa: E402
from spend import (  # noqa: E402
    build_category_children,
    nth_prior_cycle_window,
    rollover_cycle_record,
    subtree_ids,
)

_BUDGETS_KEY = {"pk": "BUDGETS", "sk": "BUDGETS"}


def _needs_rebuild(entry):
    if not (entry.get("rollover") and entry.get("carryover") and entry.get("carryover_from")
            and entry.get("carryover_len")):
        return False
    return not any(record.get("rebuilt") for record in entry.get("carryover_history", []))


def _walk_from(entry):
    """The cycle start to walk back from: the oldest saved cycle, else `carryover_from`."""
    history = entry.get("carryover_history", [])
    if history:
        return history[-1]["start"]
    return entry["carryover_from"]


def _rebuilt_cycles(entry, subtree, transactions):
    """The rebuilt records to append (newest first), or [] when none beats the gap alone."""
    history = entry.get("carryover_history", [])
    gap = entry["carryover"] - sum((record["leftover"] for record in history), Decimal(0))
    walk_from = _walk_from(entry)
    records = []
    running = Decimal(0)
    best_k, best_miss = 0, abs(gap)
    for n in range(1, ROLLOVER_HISTORY_MAX_CYCLES - len(history) + 1):
        window_start, window_end = nth_prior_cycle_window(walk_from, int(entry["carryover_len"]), n)
        record = rollover_cycle_record(entry["target"], window_start, window_end, subtree, transactions)
        records.append({**record, "rebuilt": True})
        running += record["leftover"]
        if abs(gap - running) < best_miss:
            best_k, best_miss = n, abs(gap - running)
    return records[:best_k]


def run(entries, categories, transactions, write, dry_run=True):
    bucket_by_id = {category["id"]: category.get("bucket") for category in categories}
    children = build_category_children(categories)
    rebuilt = skipped = 0
    for category_id, entry in entries.items():
        if not _needs_rebuild(entry):
            continue
        subtree = subtree_ids(category_id, children, bucket_by_id)
        additions = _rebuilt_cycles(entry, subtree, transactions)
        if not additions:
            print(category_id, "carryover", entry["carryover"], "— no cycles match, left as is")
            continue
        history = entry.get("carryover_history", []) + additions
        total = sum((record["leftover"] for record in history), Decimal(0))
        print(category_id, "carryover", entry["carryover"])
        for record in history:
            marker = " (rebuilt)" if record.get("rebuilt") else ""
            print(f"  {record['start']} – {record['end']}  {record['leftover']}{marker}")
        print("  sum", total, "not matched to a cycle", entry["carryover"] - total)
        if dry_run:
            continue
        if write(category_id, history):
            rebuilt += 1
        else:
            skipped += 1
    return {"rebuilt": rebuilt, "skipped": skipped}


def _transaction_range(entries):
    """[start, end] covering every cycle the rebuild might walk back over."""
    starts, ends = [], []
    for entry in entries.values():
        if not _needs_rebuild(entry):
            continue
        walk_from = _walk_from(entry)
        starts.append(nth_prior_cycle_window(walk_from, int(entry["carryover_len"]),
                                             ROLLOVER_HISTORY_MAX_CYCLES)[0])
        ends.append((date.fromisoformat(walk_from) - timedelta(days=1)).isoformat())
    if not starts:
        return None
    return min(starts), max(ends)


def main():
    dry_run = "--apply" not in sys.argv[1:]
    table = boto3.resource("dynamodb", region_name=os.environ["AWS_REGION"]).Table(os.environ["TABLE_NAME"])
    item = table.get_item(Key=_BUDGETS_KEY).get("Item")
    if item is None:
        print("No budgets saved — nothing to rebuild.")
        return
    entries = item["items"]
    version = {"current": item["version"]}

    def write(category_id, history):
        try:
            table.update_item(
                Key=_BUDGETS_KEY,
                UpdateExpression="SET #items.#id.#history = :history, #v = :next",
                ConditionExpression="#v = :expected",
                ExpressionAttributeNames={"#items": "items", "#id": category_id,
                                          "#history": "carryover_history", "#v": "version"},
                ExpressionAttributeValues={":history": history, ":expected": version["current"],
                                           ":next": version["current"] + Decimal(1)},
            )
        except ClientError as e:
            if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return False
            raise
        version["current"] += Decimal(1)
        return True

    date_range = _transaction_range(entries)
    if date_range is None:
        print("No rollover budget needs rebuilding.")
        return
    transactions = read_window(TransactionRepository(), *date_range)
    categories = CategoryRepository().list_categories()

    result = run(entries, categories, transactions, write, dry_run=dry_run)
    if dry_run:
        print("Dry run — nothing saved. Re-run with --apply to save.")
    print(result)


if __name__ == "__main__":
    main()
