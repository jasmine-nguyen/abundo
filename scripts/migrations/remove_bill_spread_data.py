"""One-off clean-up (ABU-91): delete the saved bill spread fields from budgets and rules.

Bill spread was removed from the app and server. This deletes what it left behind: the
`spread_*` fields on each budget entry and the `spread*` fields on each rule row. Nothing else
changes — targets, rollover, carryover and every other rule field stay as they are.

Run only after the server release that removes bill spread: the old code re-saves these fields.

Safe to run twice. Dry run by default — pass --apply to save. Each budget write is conditional on
the budgets item's version not having moved since the read, so once one is refused the rest of
that run's budget writes are skipped too (re-run to pick them up). Each rule write is conditional
on the rule still existing.
Set TABLE_NAME / AWS_REGION below (or via env), have AWS creds in the environment, then run."""

import os
import sys
from decimal import Decimal

os.environ.setdefault("TABLE_NAME", "abundo-dynamodb-table")
os.environ.setdefault("AWS_REGION", "ap-southeast-2")

import boto3  # noqa: E402
from boto3.dynamodb.conditions import Key  # noqa: E402
from botocore.exceptions import ClientError  # noqa: E402

_BUDGETS_KEY = {"pk": "BUDGETS", "sk": "BUDGETS"}

BUDGET_SPREAD_FIELDS = ("spread_amount", "spread_cycles", "spread_from", "spread_len", "spread_paydate")
RULE_SPREAD_FIELDS = ("spread", "spread_amount", "spread_gap_days", "spread_seeded")


def _present(row, fields):
    return [field for field in fields if field in row]


def _update(table, **kwargs):
    """True when the write landed, False when its condition was refused."""
    try:
        table.update_item(**kwargs)
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise
    return True


def _clean_budgets(table, budgets_item, dry_run, counts):
    if budgets_item is None:
        return
    version = budgets_item["version"]
    for category_id, entry in budgets_item["items"].items():
        fields = _present(entry, BUDGET_SPREAD_FIELDS)
        if not fields:
            continue
        counts["budgets_found"] += 1
        print("budget", category_id, {field: entry[field] for field in fields})
        if dry_run:
            continue
        names = {"#items": "items", "#id": category_id, "#v": "version"}
        names.update({f"#f{i}": field for i, field in enumerate(fields)})
        removes = ", ".join(f"#items.#id.#f{i}" for i in range(len(fields)))
        landed = _update(
            table,
            Key=_BUDGETS_KEY,
            UpdateExpression=f"REMOVE {removes} SET #v = :next",
            ConditionExpression="#v = :expected",
            ExpressionAttributeNames=names,
            ExpressionAttributeValues={":expected": version, ":next": version + Decimal(1)},
        )
        if not landed:
            counts["skipped"] += 1
            continue
        version += Decimal(1)
        counts["budgets_cleaned"] += 1


def _clean_rules(table, rule_rows, dry_run, counts):
    for row in rule_rows:
        fields = _present(row, RULE_SPREAD_FIELDS)
        if not fields:
            continue
        counts["rules_found"] += 1
        print("rule", row.get("id"), repr(row.get("value")), {field: row[field] for field in fields})
        if dry_run:
            continue
        names = {"#pk": "pk"}
        names.update({f"#f{i}": field for i, field in enumerate(fields)})
        removes = ", ".join(f"#f{i}" for i in range(len(fields)))
        landed = _update(
            table,
            Key={"pk": row["pk"], "sk": row["sk"]},
            UpdateExpression=f"REMOVE {removes}",
            ConditionExpression="attribute_exists(#pk)",
            ExpressionAttributeNames=names,
        )
        if not landed:
            counts["skipped"] += 1
            continue
        counts["rules_cleaned"] += 1


def run(table, budgets_item, rule_rows, dry_run=True):
    counts = {"budgets_found": 0, "budgets_cleaned": 0, "rules_found": 0, "rules_cleaned": 0, "skipped": 0}
    _clean_budgets(table, budgets_item, dry_run, counts)
    _clean_rules(table, rule_rows, dry_run, counts)
    return counts


def _rule_rows(table):
    rows = []
    kwargs = {"KeyConditionExpression": Key("pk").eq("RULE")}
    while True:
        page = table.query(**kwargs)
        rows.extend(page.get("Items", []))
        if "LastEvaluatedKey" not in page:
            return rows
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def main():
    dry_run = "--apply" not in sys.argv[1:]
    table = boto3.resource("dynamodb", region_name=os.environ["AWS_REGION"]).Table(os.environ["TABLE_NAME"])
    budgets_item = table.get_item(Key=_BUDGETS_KEY).get("Item")
    result = run(table, budgets_item, _rule_rows(table), dry_run=dry_run)
    if dry_run:
        print("Dry run — nothing saved. Re-run with --apply to save.")
    print(result)


if __name__ == "__main__":
    main()
