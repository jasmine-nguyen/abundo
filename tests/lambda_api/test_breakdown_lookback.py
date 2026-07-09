"""WHIT-68 — adversarial QA gaps for the /breakdown historical look-back (?cycle=).

Complements tests/lambda_api/test_breakdown.py (the implementer's happy-path +
cycle=1 endpoint tests). Here we cover the gaps the implementer's tests leave open:
  [A20] multi-cycle deep look-back (cycle=2) reads the right NON-overlapping window
        end-to-end through list_category_breakdown (they only assert cycle=1);
  [A21] cap boundary EXACTNESS — cycle == BREAKDOWN_MAX_LOOKBACK (12) is allowed
        (200) end-to-end, and the parser accepts 12 but rejects 13 (off-by-one bite);
  [A22] the Uncategorized bucket appears correctly in a PAST cycle (they only test it
        in the current window);
  [A23]/[A24] length=7 and length=30 PRIOR windows through the endpoint (they only
        unit-test the helper for these cadences, not end-to-end).

Same direct-call + _DateFilteringTransactionRepo + monkeypatched spend._melbourne_today
pattern as test_breakdown.py.
"""

from datetime import date
from decimal import Decimal

import pytest


class _DateFilteringTransactionRepo:
    """Honours the inclusive [start, end] date bounds like DynamoDB `between`, so a
    window test can prove exactly which dates are pulled. Serves the pool once total."""

    def __init__(self, transactions):
        self._txns = list(transactions)
        self._served = False
        self.calls = []

    def get_transactions_by_date_range(self, account_id, start_date, end_date, limit=20, cursor=None):
        self.calls.append((account_id, start_date, end_date, limit, cursor))
        if self._served:
            return [], None
        self._served = True
        page = [t for t in self._txns if start_date <= t["date"] <= end_date]
        return page, None


class FakeCategoryRepo:
    def __init__(self, categories=None):
        self._categories = categories or []

    def list_categories(self):
        return [dict(c) for c in self._categories]


class FakePayCycleRepo:
    def __init__(self, length=14, last_pay_date="2024-01-03"):
        self._cycle = {"length": length, "last_pay_date": last_pay_date}

    def get_paycycle(self):
        return dict(self._cycle)


def _category(cat_id, bucket, name=None):
    return {"id": cat_id, "name": name or cat_id.title(), "icon": "tag",
            "color": "#123456", "bucket": bucket}


def _dated(cat, amount, d, status="posted", counts=True):
    return {"category": cat, "amount": Decimal(str(amount)), "status": status,
            "counts_to_budget": counts, "date": d}


# today 2024-01-16, fortnightly, last pay 2024-01-03 -> current cycle_start = 2024-01-03.
#   cycle=1 window: [2023-12-20, 2024-01-02]
#   cycle=2 window: [2023-12-06, 2023-12-19]
#   cycle=3 window: [2023-11-22, 2023-12-05]


def test_breakdown_cycle_2_reads_the_second_prior_window_end_to_end(handler, monkeypatch):
    # [A20] cycle=2 must read the 2nd-prior window ONLY — not the current, not cycle=1,
    # not cycle=3. Proves the n-step is non-overlapping all the way through the endpoint,
    # which the implementer's cycle=1-only endpoint test can't catch (n vs 1 collapse).
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: date(2024, 1, 16))
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = _DateFilteringTransactionRepo([
        _dated("coffee", -1, "2024-01-10"),   # current  -> OUT
        _dated("coffee", -2, "2024-01-01"),   # cycle=1  -> OUT
        _dated("coffee", -7, "2023-12-19"),   # cycle=2 (last day)  -> IN
        _dated("coffee", -3, "2023-12-06"),   # cycle=2 (first day) -> IN
        _dated("coffee", -9, "2023-12-05"),   # cycle=3 (day before) -> OUT
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo(), cycle=2)

    assert result == {"coffee": {"posted": Decimal("10"), "pending": Decimal("0")}}
    assert txns.calls[0][1] == "2023-12-06"  # queried start = 2nd-prior window start
    assert txns.calls[0][2] == "2023-12-19"  # queried end   = 2nd-prior window end


def test_breakdown_cap_boundary_cycle_12_is_served_not_rejected(handler, monkeypatch):
    # [A21] cycle == BREAKDOWN_MAX_LOOKBACK (12) is the LAST allowed value: it must run
    # the body (200), not 400. Guards the off-by-one in the `cycle > CAP` check. The
    # window is far in the past -> empty {}, and 200 with {} is the correct answer.
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: date(2024, 1, 16))
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = _DateFilteringTransactionRepo([_dated("coffee", -20, "2024-01-10")])
    monkeypatch.setattr(handler, "CategoryRepository", lambda: cats)
    monkeypatch.setattr(handler, "TransactionRepository", lambda: txns)
    monkeypatch.setattr(handler, "PayCycleRepository", FakePayCycleRepo)

    event = {"rawPath": "/breakdown", "requestContext": {"http": {"method": "GET"}},
             "queryStringParameters": {"cycle": "12"}}
    resp = handler.lambda_handler(event, None)

    assert resp["statusCode"] == 200
    import json
    assert json.loads(resp["body"]) == {}


def test_parse_breakdown_cycle_cap_is_inclusive_at_12_exclusive_at_13(handler):
    # [A21] Parser off-by-one: 12 accepted (12, None); 13 rejected with a 400. The
    # implementer's parse test only checks -1 and the dispatch parametrize only checks
    # 13/999 reject — neither pins that 12 is the accepted upper boundary.
    assert handler._parse_breakdown_cycle({"queryStringParameters": {"cycle": "12"}}) == (12, None)
    cycle, err = handler._parse_breakdown_cycle({"queryStringParameters": {"cycle": "13"}})
    assert cycle == 0 and err["statusCode"] == 400


def test_breakdown_uncategorized_bucket_appears_in_a_past_cycle(handler, monkeypatch):
    # [A22] Uncategorized must roll up in a PRIOR window too, not just the current one:
    # a raw BankSync enum dated in the cycle=1 window folds into __uncategorized__, while
    # the same enum dated in the current window is excluded from the cycle=1 answer.
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: date(2024, 1, 16))
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = _DateFilteringTransactionRepo([
        _dated("coffee", -10, "2023-12-25"),      # prior window, spend cat -> IN
        _dated("MEDICAL", -8, "2023-12-26"),      # prior window, raw enum  -> IN (uncategorized)
        _dated("MEDICAL", -99, "2024-01-10"),     # current window          -> OUT of cycle=1
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo(), cycle=1)

    assert result["coffee"] == {"posted": Decimal("10"), "pending": Decimal("0")}
    assert result["__uncategorized__"] == {"posted": Decimal("8"), "pending": Decimal("0")}


def test_breakdown_prior_window_weekly_length_7_end_to_end(handler, monkeypatch):
    # [A23] length=7: last pay 2024-01-01, today 2024-01-16 -> cycle_start = 2024-01-15,
    # so cycle=1 window is [2024-01-08, 2024-01-14]. Proves the endpoint honours a weekly
    # cadence's prior window (helper is unit-tested for 7, but not through list_category_breakdown).
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: date(2024, 1, 16))
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = _DateFilteringTransactionRepo([
        _dated("coffee", -5, "2024-01-10"),   # prior week   -> IN
        _dated("coffee", -50, "2024-01-15"),  # current week -> OUT
        _dated("coffee", -7, "2024-01-07"),   # week before  -> OUT
    ])

    result = handler.list_category_breakdown(
        cats, txns, FakePayCycleRepo(length=7, last_pay_date="2024-01-01"), cycle=1)

    assert result == {"coffee": {"posted": Decimal("5"), "pending": Decimal("0")}}
    assert txns.calls[0][1] == "2024-01-08"
    assert txns.calls[0][2] == "2024-01-14"


def test_breakdown_prior_window_monthly_length_30_end_to_end(handler, monkeypatch):
    # [A24] length=30: last pay 2024-01-01, today 2024-01-16 -> cycle_start = 2024-01-01,
    # so cycle=1 window is [2023-12-02, 2023-12-31]. End-to-end guard for the 30-day cadence.
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: date(2024, 1, 16))
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = _DateFilteringTransactionRepo([
        _dated("coffee", -11, "2023-12-15"),  # prior month    -> IN
        _dated("coffee", -50, "2024-01-05"),  # current month  -> OUT
        _dated("coffee", -9, "2023-12-01"),   # month before   -> OUT (day before prior start)
    ])

    result = handler.list_category_breakdown(
        cats, txns, FakePayCycleRepo(length=30, last_pay_date="2024-01-01"), cycle=1)

    assert result == {"coffee": {"posted": Decimal("11"), "pending": Decimal("0")}}
    assert txns.calls[0][1] == "2023-12-02"
    assert txns.calls[0][2] == "2023-12-31"
