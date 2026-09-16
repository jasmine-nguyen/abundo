"""WHIT-561: the webhook filer applies a multi-condition rule (conditions + AND/OR). Driven through
the `lam` fixture so rule_ingest -> _to_engine_rule -> rule_engine resolve as the deployed webhook."""

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


def _charge(merchant_name="UBER", amount=Decimal("-25.00"), category=None, description="UBER TRIP"):
    return {"transaction_id": "t1", "account_id": "up-spending", "description": description,
            "merchant_name": merchant_name, "amount": amount, "category": category,
            "counts_to_budget": True}


_UNDER_30 = [{"field": "merchant", "operator": "contains", "value": "uber"},
             {"field": "amount", "operator": "less_than", "value": "30"}]


def test_webhook_files_a_charge_when_all_conditions_hold(lam):
    charge = _charge(amount=Decimal("-25.00"))
    lam.rule_ingest.apply([charge], rule_repo=_Store([_multi_row(_UNDER_30)]),
                          category_repo=_Cats(["transport"]))
    assert charge["category"] == "transport"


def test_webhook_leaves_unfiled_when_an_and_condition_fails(lam):
    charge = _charge(amount=Decimal("-40.00"))   # merchant matches, amount does not
    lam.rule_ingest.apply([charge], rule_repo=_Store([_multi_row(_UNDER_30)]),
                          category_repo=_Cats(["transport"]))
    assert charge["category"] is None


def test_webhook_any_logic_files_on_a_single_matching_condition(lam):
    any_rule = _multi_row([{"field": "merchant", "operator": "equals", "value": "uber"},
                           {"field": "amount", "operator": "greater_than", "value": "9999"}],
                          logic="any")
    # merchant matches the raw description (WHIT-561 follow-up), so equals compares to it; a
    # non-matching merchant_name also pins that the source is the description, not merchant_name.
    charge = _charge(description="UBER", merchant_name="LYFT", amount=Decimal("-25.00"))
    lam.rule_ingest.apply([charge], rule_repo=_Store([any_rule]),
                          category_repo=_Cats(["transport"]))
    assert charge["category"] == "transport"
