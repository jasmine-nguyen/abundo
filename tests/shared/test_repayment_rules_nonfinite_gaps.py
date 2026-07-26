"""WHIT-327 (PART B) — adversarial NON-FINITE gaps for the shared repayment rule.

Independent of the implementer's tests in test_repayment_rules.py. Their
test_is_number_rejects_non_finite locks is_number in ISOLATION (quiet NaN + inf).
These lock the behaviour that actually CHANGED, end-to-end through the public rule:

  * an infinite amount was ACCEPTED as a repayment before PART B (inf > 0 is True,
    Decimal('Infinity') > 0 is True) — the headline behaviour change is that the
    rule now rejects it;
  * a Decimal('NaN') amount used to RAISE InvalidOperation at the rule's `> 0`
    (a 500) — now cleanly False, not an exception;
  * signalling NaN (sNaN) — a distinct Decimal value the implementer never tested
    (they only used quiet Decimal('NaN')); is_number must reject it too;
  * a huge but FINITE Decimal must still be accepted — finiteness is not a
    magnitude cap, so no legitimate large amount regressed.
"""

from decimal import Decimal

INCOMING = "TRANSFER_INCOMING"


def _row(**overrides):
    row = {"type": INCOMING, "amount": Decimal("3667.50"), "date": "2026-07-01"}
    row.update(overrides)
    return row


def test_is_repayment_credit_rejects_infinite_amount(shared):
    # [A_INF] (P0) The behaviour change PART B exists for: before, inf > 0 was True and
    # Decimal('Infinity') > 0 was True, so an infinite amount was accepted as a repayment
    # credit. Now it is rejected. [fail-on-revert] reverting is_number's finiteness
    # branches makes both of these True again.
    is_repayment_credit = shared.repayment_rules.is_repayment_credit
    assert is_repayment_credit(_row(amount=float("inf"))) is False
    assert is_repayment_credit(_row(amount=Decimal("Infinity"))) is False


def test_is_repayment_credit_survives_decimal_nan_without_raising(shared):
    # [A_NANRULE] (P0) A stored Decimal('NaN') amount used to reach `amount > 0` and raise
    # decimal.InvalidOperation (a 500). The rule must now return False WITHOUT raising.
    # [fail-on-revert] reverting the finiteness branches makes this raise InvalidOperation.
    is_repayment_credit = shared.repayment_rules.is_repayment_credit
    assert is_repayment_credit(_row(amount=Decimal("NaN"))) is False


def test_is_number_rejects_signalling_nan(shared):
    # [A_SNAN] (P1) The implementer only tested quiet Decimal('NaN'). Signalling NaN is a
    # distinct value that raises InvalidOperation on comparison even more aggressively;
    # is_finite() screens it (returns False, doesn't itself raise), so is_number rejects it.
    assert shared.repayment_rules.is_number(Decimal("sNaN")) is False


def test_is_number_accepts_huge_finite_decimal(shared):
    # [A_HUGE] (P1) Finiteness must not become a magnitude cap: a real (if large) finite
    # amount is still a number. Guards against a "fix" that wrongly rejects legitimate
    # big finite values. [fail-on-revert] flipping is_number to `return False` reddens this.
    is_number = shared.repayment_rules.is_number
    assert is_number(Decimal("1E20")) is True
    assert is_number(Decimal("-1E20")) is True
