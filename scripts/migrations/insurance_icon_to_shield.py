"""One-off fix (WHIT-735): switch Insurance categories from the heartbeat ('health') icon to the
shield ('insurance'). Matches any category whose name contains "insurance" and whose icon is still
'health'. Safe to run twice. Dry run by default — pass --apply to write. The write is conditional on
the categories' version and each icon being unchanged since the read, so a save in between is a
conflict: nothing is written, re-run it.
Set TABLE_NAME / AWS_REGION below (or via env), have AWS creds in the environment, then run."""

import os
import sys

import boto3
from botocore.exceptions import ClientError

TABLE_NAME = os.environ.get("TABLE_NAME", "abundo-dynamodb-table")
AWS_REGION = os.environ.get("AWS_REGION", "ap-southeast-2")
_KEY = {"pk": "CATEGORIES", "sk": "CATEGORIES"}
_OLD_ICON = "health"
_NEW_ICON = "insurance"


def plan(items):
    return [
        cat_id for cat_id, cat in items.items()
        if "insurance" in cat["name"].strip().lower() and cat.get("icon") == _OLD_ICON
    ]


def apply(table, ids, version):
    names = {"#items": "items", "#icon": "icon", "#v": "version"}
    values = {":shield": _NEW_ICON, ":health": _OLD_ICON, ":expected": version, ":next": version + 1}
    sets, conditions = [], ["attribute_exists(pk)", "#v = :expected"]
    for i, cat_id in enumerate(ids):
        names[f"#id{i}"] = cat_id
        path = f"#items.#id{i}.#icon"
        sets.append(f"{path} = :shield")
        conditions.append(f"attribute_exists(#items.#id{i})")
        conditions.append(f"{path} = :health")
    sets.append("#v = :next")
    try:
        table.update_item(
            Key=_KEY,
            UpdateExpression="SET " + ", ".join(sets),
            ConditionExpression=" AND ".join(conditions),
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
        )
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise


def run(table, item, dry_run=True):
    items = item.get("items", {})
    ids = plan(items)
    matched = [items[cat_id]["name"] for cat_id in ids]
    if not ids or dry_run:
        return {"matched": matched, "updated": 0}
    if not apply(table, ids, item["version"]):
        return {"conflict": True, "matched": matched, "updated": 0}
    return {"matched": matched, "updated": len(ids)}


def main():
    dry_run = "--apply" not in sys.argv[1:]
    table = boto3.resource("dynamodb", region_name=AWS_REGION).Table(TABLE_NAME)
    item = table.get_item(Key=_KEY, ConsistentRead=True).get("Item", {})

    result = run(table, item, dry_run=dry_run)
    if dry_run:
        print("Dry run — nothing written. Re-run with --apply.")
    if result.get("conflict"):
        print("Categories changed since read — nothing written. Re-run.")
    print(result)


if __name__ == "__main__":
    main()
