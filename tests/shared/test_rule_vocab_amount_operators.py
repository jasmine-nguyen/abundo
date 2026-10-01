"""WHIT-561 / WHIT-608 — the rule engine accepts all four amount operators, by name.

The vocabulary lives once in shared/constants.py (WHIT-608) and the engine imports it, so there
is no second copy to keep in step. This pins the four amount operators explicitly so dropping
(or adding) one reddens.
"""


def test_engine_vocabulary_carries_all_four_amount_operators(rule_engine):
    expected = {"less_than", "less_than_or_equal", "greater_than", "greater_than_or_equal"}
    assert set(rule_engine.RULE_FIELD_OPERATORS["amount"]) == expected
