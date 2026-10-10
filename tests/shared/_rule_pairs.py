"""Every supported rule (field, operator) pair, and a valid sample value for each field."""

RULE_PAIRS = [
    ("description", "contains"), ("description", "equals"),
    ("merchant", "contains"), ("merchant", "equals"),
    ("category", "equals"),
    ("account", "equals"),
    ("amount", "less_than"), ("amount", "less_than_or_equal"),
    ("amount", "greater_than"), ("amount", "greater_than_or_equal"),
    ("direction", "is"),
]
PAIR_VALUE = {"amount": "30", "direction": "debit"}
