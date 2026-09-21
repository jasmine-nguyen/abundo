"""WHIT-561 follow-up GAP test — the engine/validator amount-operator LOCKSTEP guard.

The commit widened amount operators in TWO places that must stay equal: the engine's
`rule_engine._FIELD_OPERATORS` (source of truth for what CAN be evaluated) and
`lambda_api/constants.py::RULE_FIELD_OPERATORS` (source of truth for what the API ACCEPTS).
rule_engine is deliberately constants-free (shared-layer staging + shadow landmine, AGENTS.md),
so the two dicts are UNLINKED — a single-sided edit is silent: the validator would 400 an operator
the engine can evaluate, or accept one it can't (which then matches nothing).

No existing test compares these two dicts (grep: only WHIT-136 constants_sync, which checks
`from constants import` names, not RULE_FIELD_OPERATORS). This closes that gap and pins all four
amount operators explicitly so a future single-sided edit reddens.
"""

from _lambda_api_constants import api_constant


def test_engine_and_api_field_operator_vocab_are_identical(rule_engine):
    engine = {field: set(ops) for field, ops in rule_engine._FIELD_OPERATORS.items()}
    api = {field: set(ops) for field, ops in api_constant("RULE_FIELD_OPERATORS").items()}
    assert engine == api, (
        "rule_engine._FIELD_OPERATORS and lambda_api RULE_FIELD_OPERATORS have drifted — "
        f"engine={engine} api={api}"
    )


def test_amount_field_carries_all_four_operators_on_both_sides(rule_engine):
    # Explicit enumeration: a future edit that drops (or adds to) one side is caught by name.
    expected = {"less_than", "less_than_or_equal", "greater_than", "greater_than_or_equal"}
    assert set(rule_engine._FIELD_OPERATORS["amount"]) == expected
    assert set(api_constant("RULE_FIELD_OPERATORS")["amount"]) == expected
