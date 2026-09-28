"""The user's rule book (WHIT-623) — the one place a saved rule row becomes the matcher's shape.

The webhook (lambda/rule_ingest.py), the API routes and the apply-rules worker all read rules
through `rule_from_row`, so they can never drift apart on which fields reach the matcher.
`rule_reply` is the same rule as the app sees it (without the internal `spreadSeeded` flag).

Constants-free and banksync-free at import: the webhook and the API bundle different constants.
"""


def rule_from_row(row: dict) -> dict:
    """A stored rule row (repository_rule, snake_case) in the engine's shape (camelCase)."""
    return {
        "id": row.get("id"),
        "field": row.get("field"),
        "operator": row.get("operator"),
        "value": row.get("value"),
        "categoryId": row.get("category_id"),
        "budgetExcluded": bool(row.get("budget_excluded")),
        # WHIT-559: the spread action, whether its plan was already created, and the captured bill.
        "spread": bool(row.get("spread")),
        "spreadSeeded": bool(row.get("spread_seeded")),
        "spreadAmount": row.get("spread_amount"),
        "spreadGapDays": row.get("spread_gap_days"),
        # WHIT-541: None on a single-condition rule; the engine then reads field/operator/value.
        "conditions": row.get("conditions"),
        "logic": row.get("logic"),
    }


def rule_reply(rule: dict) -> dict:
    """An engine-shaped rule as the app receives it — `spreadSeeded` is internal bookkeeping."""
    return {key: value for key, value in rule.items() if key != "spreadSeeded"}
