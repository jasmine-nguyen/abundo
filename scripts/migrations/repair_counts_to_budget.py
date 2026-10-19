"""One-off repair (ABU-103): recompute each saved charge's `counts_to_budget` from its category.

Before ABU-31 a hand re-file kept the import's answer, worked out from the bank's raw category,
so e.g. a TRANSFER_OUT charge filed as Groceries still stays out of every budget. This goes over
every `TXN#` row (pending and posted) under each `ACCOUNT#<id>` and sets `counts_to_budget` to
`counts_to_budget(account_id, category)`, the rule the bank import uses. Only rows that differ are
written; `budget_excluded` and every other field stay as they are. Home-loan rows stay False.

Run only AFTER the release carrying ABU-31 and the ABU-103 re-sync fix: before it, a bank re-send
resets repaired rows to the raw-category answer.

Rows settled while a rules read failed (`with_carried_category` called with `is_unfiled=None`)
can still come out wrong after this run; re-running the script fixes them.

Safe to run twice. Dry run by default — pass --apply to save. Each write is conditional on the
row's category not having changed since the read, so a re-file landing mid-run wins.
Set TABLE_NAME / AWS_REGION below (or via env), have AWS creds in the environment, then run."""

import os
import pathlib
import sys

os.environ.setdefault("TABLE_NAME", "abundo-dynamodb-table")
os.environ.setdefault("AWS_REGION", "ap-southeast-2")
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "shared"))

import boto3  # noqa: E402
from boto3.dynamodb.conditions import Key  # noqa: E402
from botocore.exceptions import ClientError  # noqa: E402

from constants import ACCOUNT_ID_MAP  # noqa: E402
from spend import counts_to_budget  # noqa: E402


def _update(table, **kwargs):
    """True when the write landed, False when its condition was refused."""
    try:
        table.update_item(**kwargs)
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise
    return True


def _charge_rows(table, account_id):
    rows = []
    kwargs = {"KeyConditionExpression": Key("pk").eq(f"ACCOUNT#{account_id}")}
    while True:
        page = table.query(**kwargs)
        rows.extend(row for row in page.get("Items", []) if row["sk"].startswith("TXN#"))
        if "LastEvaluatedKey" not in page:
            return rows
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def _write(table, row, expected):
    category = row.get("category")
    kwargs = {
        "Key": {"pk": row["pk"], "sk": row["sk"]},
        "UpdateExpression": "SET #b = :counts",
        "ExpressionAttributeNames": {"#b": "counts_to_budget", "#c": "category"},
        "ExpressionAttributeValues": {":counts": expected},
    }
    if category is None:
        kwargs["ExpressionAttributeNames"]["#pk"] = "pk"
        kwargs["ConditionExpression"] = "attribute_exists(#pk) AND attribute_not_exists(#c)"
    else:
        kwargs["ExpressionAttributeValues"][":category"] = category
        kwargs["ConditionExpression"] = "#c = :category"
    return _update(table, **kwargs)


def run(table, account_ids, dry_run=True):
    counts = {"checked": 0, "found": 0, "repaired": 0, "skipped": 0}
    for account_id in account_ids:
        for row in _charge_rows(table, account_id):
            counts["checked"] += 1
            expected = counts_to_budget(account_id, row.get("category"))
            if row.get("counts_to_budget") == expected:
                continue
            counts["found"] += 1
            print(account_id, row.get("transaction_id"), row.get("date"), row.get("status"),
                  repr(row.get("category")), row.get("counts_to_budget"), "->", expected)
            if dry_run:
                continue
            if not _write(table, row, expected):
                counts["skipped"] += 1
                continue
            counts["repaired"] += 1
    return counts


def main():
    dry_run = "--apply" not in sys.argv[1:]
    table = boto3.resource("dynamodb", region_name=os.environ["AWS_REGION"]).Table(os.environ["TABLE_NAME"])
    result = run(table, list(ACCOUNT_ID_MAP.values()), dry_run=dry_run)
    if dry_run:
        print("Dry run — nothing saved. Re-run with --apply to save.")
    print(result)


if __name__ == "__main__":
    main()
