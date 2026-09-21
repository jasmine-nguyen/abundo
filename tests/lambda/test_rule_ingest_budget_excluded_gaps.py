"""WHIT-558 gap — the webhook rule mapper stays backward-compatible.

_to_engine_rule mirrors the API's _rule_to_client: a rule row written before WHIT-558 has NO
budget_excluded key, and the mapper must default it to False (bool(row.get(...))), never KeyError —
otherwise a single legacy row poisons the whole rule load and every charge lands unfiled. Also pins
that a truthy stored flag maps through to the engine shape's `budgetExcluded`.
"""


def test_legacy_row_without_the_flag_maps_to_budget_excluded_false(lam):
    engine_rule = lam.rule_ingest._to_engine_rule(
        {"id": "r1", "field": "description", "operator": "contains",
         "value": "COLES", "category_id": "groceries", "source": "app"})
    assert engine_rule["budgetExcluded"] is False


def test_stored_true_flag_maps_through_to_the_engine_shape(lam):
    engine_rule = lam.rule_ingest._to_engine_rule(
        {"id": "r1", "field": "description", "operator": "contains",
         "value": "COLES", "category_id": "groceries", "budget_excluded": True})
    assert engine_rule["budgetExcluded"] is True
