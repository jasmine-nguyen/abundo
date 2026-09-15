"""WHIT-564 — matching-behaviour-unchanged guard for the rule engine.

WHIT-564 changes only what an amount rule STORES (the canonical string), never how a stored value is
MATCHED. This locks the acceptance criterion "matching behaviour must be unchanged": the engine reads
an amount value with Decimal(str(value)), so every spelling of one amount — canonical "30", the old
raw "30.00" a pre-fix row still carries, exponent "3e1" — matches EXACTLY the same charges. If the
engine ever started comparing amount values as strings, these reddens.

Pure rule_engine unit test (the `rule_engine` fixture) — no fake, no handler.
"""

from decimal import Decimal


def _amount_rule(value, operator="less_than"):
    return {"field": "amount", "operator": operator, "value": value}


def _txn(amount):
    return {"amount": amount, "description": "X", "merchant_name": "X", "account_id": "a"}


def test_amount_match_is_identical_across_spellings(rule_engine):
    # [A15] -25 is under $30 regardless of how the threshold was written; -40 is not. The stored
    # spelling must not shift the boundary.
    for spelling in ["30", "30.0", "30.00", "3e1", "30.000"]:
        rule = _amount_rule(spelling)
        assert rule_engine.rule_matches(rule, _txn(Decimal("-25.00"))) is True, spelling
        assert rule_engine.rule_matches(rule, _txn(Decimal("-40.00"))) is False, spelling


def test_boundary_is_strict_and_spelling_stable(rule_engine):
    # [A16] Exactly-at-threshold stays a non-match for less_than under every spelling (strict <), so
    # the canonicalised "30" behaves identically to a legacy "30.00" row at the boundary.
    for spelling in ["30", "30.00"]:
        assert rule_engine.rule_matches(_amount_rule(spelling), _txn(Decimal("-30.00"))) is False
        assert rule_engine.rule_matches(
            _amount_rule(spelling, "greater_than"), _txn(Decimal("-30.00"))) is False
