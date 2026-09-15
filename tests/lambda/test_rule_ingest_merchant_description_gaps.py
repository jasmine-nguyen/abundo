"""WHIT-561 follow-up GAP test — the webhook filer matches a `merchant` rule against the RAW
DESCRIPTION end-to-end (not the cleaned merchant_name). The implementer proved this in the pure
engine and flipped the `any`-logic webhook case; this isolates the field switch END-TO-END through
rule_ingest.apply, including the negative: a charge whose merchant_name holds the value but whose
description does not must NOT be filed. Driven through the `lam` fixture (deployed webhook path)."""

from decimal import Decimal


class _Store:
    def __init__(self, rules):
        self._rules = [dict(rule) for rule in rules]

    def list_rules(self):
        return [dict(rule) for rule in self._rules]


class _Cats:
    def __init__(self, ids):
        self._ids = list(ids)

    def list_categories(self):
        return [{"id": category_id} for category_id in self._ids]


def _multi_row(conditions, logic="all", category_id="transport", rule_id="m1"):
    first = conditions[0]
    return {"id": rule_id, "field": first["field"], "operator": first["operator"],
            "value": first["value"], "category_id": category_id,
            "conditions": conditions, "logic": logic}


def _charge(description, merchant_name, amount=Decimal("-25.00"), category=None):
    return {"transaction_id": "t1", "account_id": "up-spending", "description": description,
            "merchant_name": merchant_name, "amount": amount, "category": category,
            "counts_to_budget": True}


_MERCHANT_COLES = [{"field": "merchant", "operator": "contains", "value": "coles"}]


def test_webhook_files_when_the_value_is_in_the_description_only(lam):
    # merchant_name is a different string; description carries the value -> filed. FAIL-ON-REVERT:
    # if any webhook path still read merchant_name, this WOULDN'T file.
    charge = _charge(description="COLES 0345 RICHMOND", merchant_name="Woolworths")
    lam.rule_ingest.apply([charge], rule_repo=_Store([_multi_row(_MERCHANT_COLES)]),
                          category_repo=_Cats(["transport"]))
    assert charge["category"] == "transport"


def test_webhook_does_not_file_when_the_value_is_only_in_merchant_name(lam):
    # merchant_name carries the value but the description does not -> left unfiled. This is the
    # behaviour the fix INTRODUCED; the old code (matching merchant_name) would have filed it.
    charge = _charge(description="WOOLWORTHS 1234", merchant_name="Coles")
    lam.rule_ingest.apply([charge], rule_repo=_Store([_multi_row(_MERCHANT_COLES)]),
                          category_repo=_Cats(["transport"]))
    assert charge["category"] is None
