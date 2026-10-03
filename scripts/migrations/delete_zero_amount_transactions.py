"""One-off cleanup (WHIT-705): delete stored transactions whose amount is exactly $0.00.
Safe to run twice. Dry run by default — pass --apply to delete. Each delete is conditional on the
amount still being 0, so a row that changed since the scan is skipped. No "deleted by you" marker
is written: the webhook already drops $0.00 rows on arrival.
Set TABLE_NAME / AWS_REGION below (or via env), have AWS creds in the environment, then run."""

import os
import sys
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Attr
from botocore.exceptions import ClientError

TABLE_NAME = os.environ.get("TABLE_NAME", "abundo-dynamodb-table")
AWS_REGION = os.environ.get("AWS_REGION", "ap-southeast-2")


def delete(table, row):
    try:
        table.delete_item(
            Key={"pk": row["pk"], "sk": row["sk"]},
            ConditionExpression="#amount = :zero",
            ExpressionAttributeNames={"#amount": "amount"},
            ExpressionAttributeValues={":zero": Decimal(0)},
        )
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise


def main():
    dry_run = "--apply" not in sys.argv[1:]
    table = boto3.resource("dynamodb", region_name=AWS_REGION).Table(TABLE_NAME)
    filter_expression = (
        Attr("pk").begins_with("ACCOUNT#") & Attr("sk").begins_with("TXN#") & Attr("amount").eq(0)
    )
    rows, kwargs = [], {"FilterExpression": filter_expression}
    while True:
        resp = table.scan(**kwargs)
        rows += resp.get("Items", [])
        if not resp.get("LastEvaluatedKey"):
            break
        kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]

    result = run(table, rows, dry_run=dry_run)
    if dry_run:
        print("Dry run — nothing deleted. Re-run with --apply to delete.")
    print(result)


def run(table, rows, dry_run=True):
    deleted = skipped = 0
    for row in rows:
        print(row["account_id"], row["date"], row["description"], row["amount"])
        if dry_run:
            continue
        if delete(table, row):
            deleted += 1
        else:
            skipped += 1
    return {"found": len(rows), "deleted": deleted, "skipped": skipped}


if __name__ == "__main__":
    main()
