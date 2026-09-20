"""One-off, idempotent migration: rename rule rows' smooth_* fields -> spread_*.
Safe to run twice. Preserves spread_seeded so an already-seeded plan is never re-created.
Set TABLE_NAME / AWS_REGION below (or via env), have AWS creds in the environment, then run."""

import os
import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

TABLE_NAME = os.environ.get("TABLE_NAME", "abundo-dynamodb-table")
AWS_REGION = os.environ.get("AWS_REGION", "ap-southeast-2")
_PK = "RULE"
_RENAMES = {
    "smooth": "spread",
    "smooth_amount": "spread_amount",
    "smooth_gap_days": "spread_gap_days",
    "smooth_seeded": "spread_seeded",
}


def plan_row(row):
    present = [old for old in _RENAMES if old in row]
    if not present:
        return None
    set_map, remove = {}, []
    for old in present:
        new = _RENAMES[old]
        if new not in row:  # new value wins if both somehow present
            set_map[new] = row[old]
        remove.append(old)
    return set_map, remove


def apply(table, sk, set_map, remove):
    names, values, set_clauses = {}, {}, []
    for i, (field, value) in enumerate(set_map.items()):
        names[f"#s{i}"], values[f":s{i}"] = field, value
        set_clauses.append(f"#s{i} = :s{i}")
    remove_aliases = []
    for i, field in enumerate(remove):
        names[f"#r{i}"] = field
        remove_aliases.append(f"#r{i}")
    clauses = []
    if set_clauses:
        clauses.append("SET " + ", ".join(set_clauses))
    if remove_aliases:
        clauses.append("REMOVE " + ", ".join(remove_aliases))
    kwargs = {
        "Key": {"pk": _PK, "sk": sk},
        "UpdateExpression": " ".join(clauses),
        "ExpressionAttributeNames": names,
        "ConditionExpression": "attribute_exists(pk)",  # skip a rule deleted mid-run
    }
    if values:
        kwargs["ExpressionAttributeValues"] = values
    try:
        table.update_item(**kwargs)
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise


def main():
    table = boto3.resource("dynamodb", region_name=AWS_REGION).Table(TABLE_NAME)
    rows, kwargs = [], {"KeyConditionExpression": Key("pk").eq(_PK)}
    while True:
        resp = table.query(**kwargs)
        rows += resp.get("Items", [])
        if not resp.get("LastEvaluatedKey"):
            break
        kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]

    result = run(table, rows)
    print(result)


def run(table, rows):
    migrated = 0
    for row in rows:
        plan = plan_row(row)
        if plan is None:
            continue
        if apply(table, row["sk"], *plan):
            migrated += 1
    return {"scanned": len(rows), "migrated": migrated}


if __name__ == "__main__":
    main()
