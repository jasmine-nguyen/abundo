"""WHIT-663 — the carry's date window, moved with the helper from the age-out suite (WHIT-511 [A30])."""


def test_within_days_boundaries(pending_carry):
    # Symmetric, INCLUSIVE at exactly CARRY_DATE_SKEW_DAYS. Fail-on-revert: change
    # `<= days` to `< days` and the exactly-3 case flips.
    w = pending_carry._within_days
    assert w("2026-06-10", "2026-06-13", 3) is True
    assert w("2026-06-13", "2026-06-10", 3) is True
    assert w("2026-06-10", "2026-06-14", 3) is False
    assert w("2026-06-10", "2026-06-10", 3) is True
    assert w(None, "2026-06-10", 3) is False
    assert w("2026-06-10", "", 3) is False
    assert w("not-a-date", "2026-06-10", 3) is False
