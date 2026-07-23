"""Tests for GET /repayment and the get_repayment handler (WHIT-115).

Injects a FakeTransactionRepo returning newest-first up-homeloan rows. Covers:
the repayment + same-month interest split (principal = amount - |interest|),
total-only when no interest pairs, the null sentinel when there's no repayment,
non-repayment rows ignored, and the route's DecimalEncoder JSON shaping.
"""

import json
from decimal import Decimal


class FakeTransactionRepo:
    """Handler-level stand-in: returns the given rows (assumed newest-first)."""

    def __init__(self, rows):
        self._rows = rows
        self.calls = []

    def get_transactions_by_date_range(self, account_id, start, end, limit):
        self.calls.append((account_id, start, end, limit))
        return list(self._rows), None


def _repayment(date, amount="1440"):
    return {"type": "TRANSFER_INCOMING", "category": "TRANSFER_IN", "amount": Decimal(amount), "date": date}


def _interest(date, amount="-232"):
    return {"type": "TRANSFER_OUTGOING", "category": "BANK_FEES", "amount": Decimal(amount), "date": date}


# --- get_repayment -----------------------------------------------------------


def test_pairs_same_month_interest_into_a_split(handler):
    repo = FakeTransactionRepo([_interest("2026-07-05"), _repayment("2026-07-01")])
    out = handler.get_repayment(repo)
    assert out["amount"] == Decimal("1440")
    assert out["date"] == "2026-07-01"
    # interest stored negative -> shown as magnitude; principal = amount - |interest|.
    assert out["interest"] == Decimal("232")
    assert out["principal"] == Decimal("1208")
    # It reads the whole up-homeloan partition, newest-first (no date bounds).
    assert repo.calls[0][0] == "up-homeloan"
    assert repo.calls[0][1] is None and repo.calls[0][2] is None


def test_principal_plus_interest_equals_amount(handler):
    out = handler.get_repayment(FakeTransactionRepo([_repayment("2026-07-01"), _interest("2026-07-05")]))
    assert out["principal"] + abs(out["interest"]) == out["amount"]


def test_total_only_when_interest_is_a_different_month(handler):
    # June interest must NOT pair with a July repayment.
    repo = FakeTransactionRepo([_repayment("2026-07-01"), _interest("2026-06-05")])
    out = handler.get_repayment(repo)
    assert out["amount"] == Decimal("1440")
    assert out["date"] == "2026-07-01"
    assert out["principal"] is None
    assert out["interest"] is None


def test_picks_the_newest_repayment(handler):
    repo = FakeTransactionRepo([_repayment("2026-07-01", "1440"), _repayment("2026-06-01", "1400")])
    out = handler.get_repayment(repo)
    assert out["date"] == "2026-07-01"   # first (newest) TRANSFER_INCOMING wins


def test_null_sentinel_when_no_repayment(handler):
    # A lone interest leg (no incoming transfer) is not a repayment.
    out = handler.get_repayment(FakeTransactionRepo([_interest("2026-07-05")]))
    assert out == {"amount": None, "date": None, "principal": None, "interest": None}


def test_null_sentinel_when_no_rows(handler):
    assert handler.get_repayment(FakeTransactionRepo([])) == {
        "amount": None, "date": None, "principal": None, "interest": None,
    }


def test_ignores_negative_incoming_transfer(handler):
    # Only a POSITIVE incoming transfer is a repayment credit.
    repo = FakeTransactionRepo([{"type": "TRANSFER_INCOMING", "category": "TRANSFER_IN", "amount": Decimal("-5"), "date": "2026-07-01"}])
    assert handler.get_repayment(repo)["amount"] is None


def test_returns_a_sub_ten_dollar_repayment(handler):
    # The read API has NO $10 alert floor (that's the poller's concern). A small
    # repayment must still be returned. Fail-on-revert guard: this breaks if anyone
    # bakes MIN_REPAYMENT_NOTIFY into the shared is_repayment_credit rule.
    out = handler.get_repayment(FakeTransactionRepo([_repayment("2026-07-01", "5")]))
    assert out["amount"] == Decimal("5")
    assert out["date"] == "2026-07-01"


# --- route -------------------------------------------------------------------


def test_route_get_repayment_json_numbers(handler, monkeypatch):
    repo = FakeTransactionRepo([_repayment("2026-07-01"), _interest("2026-07-05")])
    monkeypatch.setattr(handler, "TransactionRepository", lambda: repo)
    event = {"rawPath": "/repayment", "requestContext": {"http": {"method": "GET"}}}
    resp = handler.lambda_handler(event, None)
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"amount": 1440, "date": "2026-07-01", "principal": 1208, "interest": 232}


def test_route_get_repayment_null_sentinel(handler, monkeypatch):
    monkeypatch.setattr(handler, "TransactionRepository", lambda: FakeTransactionRepo([]))
    event = {"rawPath": "/repayment", "requestContext": {"http": {"method": "GET"}}}
    resp = handler.lambda_handler(event, None)
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"amount": None, "date": None, "principal": None, "interest": None}


# --- WHIT-325 GAP tests (adversarial; not duplicating the three seeded tests) -


def test_skips_a_malformed_newest_leg_and_returns_the_next_valid_repayment(handler):
    # WHIT-325 — [A30] the API-side analog of the poller's A26. The shared predicate
    # must SKIP a garbled newest leg (non-numeric amount, then a None amount) and let
    # the loop fall through to the next genuine repayment. Fail-on-revert: weaken the
    # isinstance guard in is_repayment_credit and the garbled leg is no longer skipped —
    # get_repayment then raises TypeError on 'oops' > 0, so this test goes red.
    rows = [
        {"type": "TRANSFER_INCOMING", "category": "TRANSFER_IN", "amount": "oops", "date": "2026-07-10"},
        {"type": "TRANSFER_INCOMING", "category": "TRANSFER_IN", "amount": None, "date": "2026-07-08"},
        _repayment("2026-07-01", "1440"),
    ]
    out = handler.get_repayment(FakeTransactionRepo(rows))
    assert out["amount"] == Decimal("1440")
    assert out["date"] == "2026-07-01"


def test_small_repayment_with_larger_same_month_interest_is_total_only(handler):
    # WHIT-325 — [A31] a sub-$10 repayment is selected by the shared predicate (no
    # floor) and STILL flows through the interest-summing loop. When same-month
    # interest exceeds the tiny repayment, the split is suppressed (total-only, never a
    # negative principal). Fail-on-revert twice over: a floor in the shared rule drops
    # the $5 leg (amount would be None); dropping the `interest < amount` guard yields a
    # negative principal.
    repo = FakeTransactionRepo([_repayment("2026-07-01", "5"), _interest("2026-07-05", "-8")])
    out = handler.get_repayment(repo)
    assert out["amount"] == Decimal("5")
    assert out["date"] == "2026-07-01"
    assert out["principal"] is None
    assert out["interest"] is None
