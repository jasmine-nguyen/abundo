"""WHIT-561 follow-up GAP tests (adversarial) — the new amount <= / >= operators and
merchant-against-description, probing what the implementer's boundary + fail-on-revert
cases don't: magnitude/sign interaction, fail-closed on the NEW operators, and the
_normalise-vs-fold whitespace distinction on merchant equals. Pure engine (rule_engine fixture)."""

from decimal import Decimal


def _txn(description="UBER TRIP", merchant_name="UBER", amount=Decimal("-25.00"),
         account_id="acct-1", category=None):
    return {"transaction_id": "t1", "description": description, "merchant_name": merchant_name,
            "amount": amount, "account_id": account_id, "category": category}


def _multi(conditions, logic="all", category_id="transport", rule_id="m1"):
    first = conditions[0]
    return {"id": rule_id, "categoryId": category_id, "conditions": conditions, "logic": logic,
            "field": first["field"], "operator": first["operator"], "value": first["value"]}


# --- [A20] new operators compare MAGNITUDE, so a positive credit is judged by abs() --------------


def test_le_and_ge_use_magnitude_for_a_positive_credit(rule_engine):
    # A +30 credit and a -30 debit have the same magnitude 30, so both new operators must treat
    # them identically at the boundary. FAIL-ON-REVERT: if _amount_matches compared the signed
    # value, +30 would be > any positive threshold's lower cases and the le-at-boundary would flip.
    credit_30 = _txn(amount=Decimal("30.00"))     # income, stored positive
    debit_30 = _txn(amount=Decimal("-30.00"))
    lte = _multi([{"field": "amount", "operator": "less_than_or_equal", "value": "30"}])
    gte = _multi([{"field": "amount", "operator": "greater_than_or_equal", "value": "30"}])
    assert rule_engine.rule_matches(lte, credit_30)
    assert rule_engine.rule_matches(gte, credit_30)
    assert rule_engine.rule_matches(lte, debit_30)
    assert rule_engine.rule_matches(gte, debit_30)


# --- [A21] the new operators fail CLOSED on a bad value/amount, like the strict ones -------------


def test_le_and_ge_fail_closed_on_non_numeric_value(rule_engine):
    # A non-numeric threshold must never match (fold-open would be a silent mass-mis-file).
    for op in ("less_than_or_equal", "greater_than_or_equal"):
        rule = _multi([{"field": "amount", "operator": op, "value": "lots"}])
        assert not rule_engine.rule_matches(rule, _txn(amount=Decimal("-25.00"))), op


def test_le_and_ge_fail_closed_on_missing_amount(rule_engine):
    # A charge with no amount must not match either new operator.
    for op in ("less_than_or_equal", "greater_than_or_equal"):
        rule = _multi([{"field": "amount", "operator": op, "value": "30"}])
        assert not rule_engine.rule_matches(rule, _txn(amount=None)), op


# --- [A22] merchant `equals` on description is EXACT, and uses _normalise (not fold) --------------


def test_merchant_equals_does_not_match_a_substring_description(rule_engine):
    # equals must be exact against the description, not a substring. A description that merely
    # CONTAINS the value must not match an `equals` merchant rule.
    rule = _multi([{"field": "merchant", "operator": "equals", "value": "coles"}])
    assert rule_engine.rule_matches(rule, _txn(description="COLES"))          # exact -> match
    assert not rule_engine.rule_matches(rule, _txn(description="COLES EXPRESS"))  # substring -> no match


def test_merchant_equals_does_not_collapse_internal_whitespace(rule_engine):
    # merchant now routes through _text_matches with _normalise (trim + lower), NOT fold (which
    # collapses internal whitespace runs). So "coles online" (one space) must NOT equal a
    # description "COLES  ONLINE" (two spaces). FAIL-ON-REVERT: swap _normalise for fold on this
    # path and the double-space description wrongly equals the single-space value.
    rule = _multi([{"field": "merchant", "operator": "equals", "value": "coles online"}])
    assert not rule_engine.rule_matches(rule, _txn(description="COLES  ONLINE"))
    assert rule_engine.rule_matches(rule, _txn(description="COLES ONLINE"))   # exact spacing -> match
