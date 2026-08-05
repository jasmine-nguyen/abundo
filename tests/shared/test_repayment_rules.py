"""Tests for the shared home-loan repayment-leg rule (shared/repayment_rules.py).

WHIT-325 lifted this predicate out of two drifting copies (the balance poller's
miss-detector and the read API's get_repayment). These lock its contract: identify
an incoming-transfer credit with a positive numeric amount and a date, apply NO $10
alert floor (so the read API keeps returning sub-$10 repayments), and skip a
malformed row rather than raising.
"""

from decimal import Decimal

# Mirrors constants.REPAYMENT_INCOMING_TYPE (the Up transfer-in type).
INCOMING = "TRANSFER_INCOMING"


def _row(**overrides):
    row = {"type": INCOMING, "amount": Decimal("3667.50"), "date": "2026-07-01"}
    row.update(overrides)
    return row


def test_incoming_positive_dated_credit_is_a_repayment(shared):
    assert shared.repayment_rules.is_repayment_credit(_row()) is True


def test_wrong_type_is_not_a_repayment(shared):
    assert shared.repayment_rules.is_repayment_credit(_row(type="TRANSFER_OUTGOING")) is False


def test_missing_type_is_not_a_repayment(shared):
    row = _row()
    del row["type"]
    assert shared.repayment_rules.is_repayment_credit(row) is False


def test_empty_date_is_not_a_repayment(shared):
    assert shared.repayment_rules.is_repayment_credit(_row(date="")) is False


def test_none_date_is_not_a_repayment(shared):
    assert shared.repayment_rules.is_repayment_credit(_row(date=None)) is False


def test_none_amount_is_not_a_repayment(shared):
    assert shared.repayment_rules.is_repayment_credit(_row(amount=None)) is False


def test_zero_amount_is_not_a_repayment(shared):
    assert shared.repayment_rules.is_repayment_credit(_row(amount=Decimal("0"))) is False


def test_negative_amount_is_not_a_repayment(shared):
    assert shared.repayment_rules.is_repayment_credit(_row(amount=Decimal("-5"))) is False


def test_non_numeric_amount_is_skipped_not_raised(shared):
    # A stringified amount must be skipped, never crash the caller's scan.
    assert shared.repayment_rules.is_repayment_credit(_row(amount="3667.50")) is False


def test_int_and_float_amounts_are_accepted(shared):
    assert shared.repayment_rules.is_repayment_credit(_row(amount=100)) is True
    assert shared.repayment_rules.is_repayment_credit(_row(amount=100.5)) is True


def test_sub_ten_dollar_credit_is_still_a_repayment(shared):
    # The rule carries NO $10 alert floor — that lives at the poller's call site.
    # This is the single source of truth that keeps the read API showing small repayments.
    assert shared.repayment_rules.is_repayment_credit(_row(amount=Decimal("5"))) is True


# --- WHIT-327: direct unit tests for the extracted is_number predicate ---------
# The suite above only reaches is_number THROUGH is_repayment_credit's `> 0` wrapper.
# is_number is now a public shared export called by BOTH is_repayment_credit and
# get_repayment's interest loop, so lock its contract in isolation. [fail-on-revert]
# breaking is_number to `return True` reddens the reject cases; to `return False`
# reddens the accept cases — independent of the `> 0` / `< 0` call-site checks.


def test_is_number_accepts_int_float_decimal(shared):
    # The three numeric types the repayment/interest legs are ever stored as.
    is_number = shared.repayment_rules.is_number
    assert is_number(100) is True
    assert is_number(100.5) is True
    assert is_number(Decimal("3667.50")) is True


def test_is_number_zero_and_negative_are_numbers(shared):
    # is_number is a TYPE check, not a sign/value check — 0 and negatives are numbers.
    # This is why get_repayment layers its own `< 0` (interest) and is_repayment_credit
    # its own `> 0` on top; is_number must not silently reject them.
    is_number = shared.repayment_rules.is_number
    assert is_number(0) is True
    assert is_number(Decimal("0")) is True
    assert is_number(-232) is True
    assert is_number(Decimal("-232")) is True


def test_is_number_rejects_non_numeric(shared):
    # Anything the interest loop's `amount_leg < 0` would crash on (str/None/list/…)
    # must be screened out here — the whole point of the guard.
    is_number = shared.repayment_rules.is_number
    assert is_number(None) is False
    assert is_number("-232") is False
    assert is_number("") is False
    assert is_number([]) is False
    assert is_number({}) is False
    assert is_number(b"1") is False


def test_is_number_treats_bool_as_number_characterization(shared):
    # WHIT-327 (documented in the docstring): Python treats bool as int, so is_number
    # accepts True/False, matching the prior inline/_num checks. This is DELIBERATELY not
    # tightened. Locks that behaviour: if someone "fixes" is_number to exclude bool, this
    # reddens and forces a conscious decision (bool amounts never occur in real Up data).
    is_number = shared.repayment_rules.is_number
    assert is_number(True) is True
    assert is_number(False) is True


def test_is_number_rejects_non_finite(shared):
    # WHIT-327 hardening: NaN / Infinity are rejected. A Decimal('NaN') amount would
    # otherwise raise InvalidOperation on the call sites' `> 0` / `< 0` comparison and
    # 500 the repayment card; a float NaN/inf would silently mis-sort. is_number screens
    # both, so a non-finite amount is treated as malformed and skipped. [fail-on-revert]
    # dropping the finiteness branches makes these pass-as-True → red.
    is_number = shared.repayment_rules.is_number
    assert is_number(float("nan")) is False
    assert is_number(float("inf")) is False
    assert is_number(float("-inf")) is False
    assert is_number(Decimal("NaN")) is False
    assert is_number(Decimal("Infinity")) is False


def test_bool_amount_above_zero_is_accepted_as_repayment_credit_characterization(shared):
    # The bool-as-number quirk, end-to-end through the rule: amount=True is numeric AND
    # True > 0, so a row with a boolean `True` amount is treated as a repayment credit
    # (behaviour preserved from before WHIT-327; not a target to fix here). amount=False
    # is numeric but not > 0, so it is rejected like a zero.
    assert shared.repayment_rules.is_repayment_credit(_row(amount=True)) is True
    assert shared.repayment_rules.is_repayment_credit(_row(amount=False)) is False


# --- folded from test_repayment_rules_nonfinite_gaps.py (WHIT-463) ---


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
