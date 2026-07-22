"""Tests for the home-loan repayment push copy (shared/repayment_alerts.py).

The detection/dedupe/send logic moved to the direct Up webhook
(lambda/up_webhook.py, WHIT-313); this module now owns only the wording, so these
tests lock the title and the whole-dollar amount rendering (rounding + separators).
"""

from decimal import Decimal


def test_title_is_fixed(shared):
    title, _ = shared.repayment_alerts.build_repayment_push(Decimal("3667"))
    assert title == "Nice one! Another chunk down"


def test_body_renders_whole_dollars_with_separators(shared):
    _, body = shared.repayment_alerts.build_repayment_push(Decimal("3667"))
    assert "$3,667 toward the mortgage" in body


def test_cents_round_to_whole_dollars(shared):
    _, body = shared.repayment_alerts.build_repayment_push(Decimal("3667.50"))
    assert "$3,668 toward the mortgage" in body


def test_half_to_even_rounding(shared):
    # Decimal formats with banker's rounding, so 3668.50 rounds to the even 3668.
    _, body = shared.repayment_alerts.build_repayment_push(Decimal("3668.50"))
    assert "$3,668 toward the mortgage" in body


def test_large_amount_keeps_thousands_separators(shared):
    _, body = shared.repayment_alerts.build_repayment_push(Decimal("1000000"))
    assert "$1,000,000 toward the mortgage" in body


def test_floor_amount_renders(shared):
    _, body = shared.repayment_alerts.build_repayment_push(Decimal("10.00"))
    assert "$10 toward the mortgage" in body
