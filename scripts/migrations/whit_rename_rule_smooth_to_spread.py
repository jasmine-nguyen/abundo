"""One-off, idempotent migration for the WHIT-559 rule "smooth" -> "spread" rename.

The rule action and its stored fields were renamed from smooth* to spread*. DynamoDB is
schemaless, so an existing rule row keeps its OLD attribute names until rewritten. This script
rewrites each rule row's smooth* attributes to spread*, PRESERVING every value — critically
``spread_seeded``, so a rule that already created its category's plan stays seeded and is never
re-created — then removes the old keys.

Safe to run twice: a row that carries no smooth* attribute is skipped, so a second run is a no-op.

Run against the real table (reads AWS region/creds + TABLE_NAME from the environment, like the
Lambdas):

    python scripts/migrations/whit_rename_rule_smooth_to_spread.py
"""

# The full set of renamed rule-row attributes. A new smooth*-prefixed field would have to be
# added here too (nothing else auto-discovers them).
_RENAMES = {
    "smooth": "spread",
    "smooth_amount": "spread_amount",
    "smooth_gap_days": "spread_gap_days",
    "smooth_seeded": "spread_seeded",
}


def plan_row(row: dict):
    """The rename to apply to one rule row, as ``(set_map, remove_list)``, or None if nothing to do.

    Each old value carries over verbatim. If the new key is already present (a re-run, or a
    half-applied row), its value is kept and only the stale old key is removed — so the newest
    value always wins and no already-seeded marker is lost."""
    present = [old for old in _RENAMES if old in row]
    if not present:
        return None
    set_map = {}
    remove = []
    for old in present:
        new = _RENAMES[old]
        if new not in row:
            set_map[new] = row[old]
        remove.append(old)
    return set_map, remove


def _apply(table, partition_key: str, sk: str, set_map: dict, remove: list) -> bool:
    """Rewrite one row's old keys, returning True if written, False if the row had vanished.

    The list-then-rewrite is not atomic, so the write is guarded by ``attribute_exists(pk)`` (like
    every other rule write): a rule the app deleted between the scan and this update fails the guard
    and is skipped, rather than being resurrected as a keys-only ghost row by an upsert."""
    from botocore.exceptions import ClientError

    names = {}
    values = {}
    set_clauses = []
    for index, (field, value) in enumerate(set_map.items()):
        name_alias, value_alias = f"#s{index}", f":s{index}"
        names[name_alias] = field
        values[value_alias] = value
        set_clauses.append(f"{name_alias} = {value_alias}")
    remove_aliases = []
    for index, field in enumerate(remove):
        name_alias = f"#r{index}"
        names[name_alias] = field
        remove_aliases.append(name_alias)

    clauses = []
    if set_clauses:
        clauses.append("SET " + ", ".join(set_clauses))
    if remove_aliases:
        clauses.append("REMOVE " + ", ".join(remove_aliases))

    kwargs = {
        "Key": {"pk": partition_key, "sk": sk},
        "UpdateExpression": " ".join(clauses),
        "ExpressionAttributeNames": names,
        "ConditionExpression": "attribute_exists(pk)",
    }
    if values:
        kwargs["ExpressionAttributeValues"] = values
    try:
        table.update_item(**kwargs)
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise
    return True


def migrate(repo=None) -> dict:
    """Rewrite every rule row's smooth* fields to spread*. Returns ``{scanned, migrated}``."""
    from repository_rule import RuleRepository, _PK

    repo = repo or RuleRepository()
    table = repo._get_table()
    rows = repo.list_rules()
    migrated = 0
    for row in rows:
        plan = plan_row(row)
        if plan is None:
            continue
        set_map, remove = plan
        if _apply(table, _PK, row["sk"], set_map, remove):
            migrated += 1
    return {"scanned": len(rows), "migrated": migrated}


if __name__ == "__main__":
    import pathlib
    import sys

    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "shared"))
    print(migrate())
