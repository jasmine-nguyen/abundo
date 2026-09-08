"""Tests for the bill SPREAD in the budget endpoints (WHIT-504).

A spend category can spread a one-off bill: the current cycle's spendable rises by the
full amount (a cushion, so the bill doesn't read as "over budget"), and each of the next
N cycles gives an equal slice back. GET /budgets carries a `spread` object per such
category with the signed `adjustment` for this cycle; PUT/DELETE /budgets/{id}/spread
create and remove the plan. A category has rollover OR a spread, never both.

`handler.current_cycle_window` is monkeypatched to a fixed (cycle_start, today), as the
rollover suite does, so the cycle math is deterministic. The pure slice math is pinned in
tests/shared/test_spend_spread.py; here we pin the endpoint behaviour on top of it.
"""

import json
from decimal import Decimal

import pytest

# Same fixed grid as the rollover suite: monthly, cycle_start 2026-08-06, payday grid from
# 2026-01-01. Anchors used below: 2026-08-06 (this cycle), 2026-07-07 (1 back),
# 2026-05-08 (3 back), 2026-04-08 (4 back), 2026-03-09 (5 back).
CYCLE_START = "2026-08-06"
TODAY = "2026-08-10"
LENGTH = 30
PAYDATE = "2026-01-01"

BILL = Decimal("1390.91")   # over 4 cycles: slices 347.73, 347.73, 347.73, 347.72


class FakeBudgetRepo:
    def __init__(self, budgets=None):
        self._budgets = budgets or {}
        self.set_calls = []
        self.set_spread_calls = []
        self.clear_spread_calls = []
        self.delete_calls = []
        self.clear_spread_raises = False

    def list_budgets(self):
        return {k: dict(v) for k, v in self._budgets.items()}

    def set_budget(self, cat_id, target, rollover=None, anchor=None):
        self.set_calls.append((cat_id, target))
        return {"id": cat_id, "target": target}

    def set_spread(self, cat_id, amount, cycles, spread_from, spread_len, spread_paydate):
        self.set_spread_calls.append((cat_id, amount, cycles, spread_from, spread_len, spread_paydate))
        # The write lands, so a second read sees a plan the first read re-saved.
        self._budgets.setdefault(cat_id, {}).update({
            "spread_amount": amount, "spread_cycles": Decimal(cycles), "spread_from": spread_from,
            "spread_len": Decimal(spread_len), "spread_paydate": spread_paydate,
        })
        return {"id": cat_id, "amount": amount, "cycles": cycles}

    def clear_spread(self, cat_id):
        self.clear_spread_calls.append(cat_id)
        if self.clear_spread_raises:
            raise RuntimeError("boom")   # exercises the best-effort swallow
        for key in ("spread_amount", "spread_cycles", "spread_from", "spread_len", "spread_paydate"):
            self._budgets.get(cat_id, {}).pop(key, None)

    def settle_carryover(self, cat_id, carryover, carryover_from, carryover_len, carryover_paydate):
        self._budgets.setdefault(cat_id, {}).update({
            "carryover": carryover, "carryover_from": carryover_from,
            "carryover_len": Decimal(carryover_len), "carryover_paydate": carryover_paydate,
        })

    def delete_budget(self, cat_id):
        self.delete_calls.append(cat_id)


class FakeTransactionRepo:
    def __init__(self, transactions=None):
        self._queue = [(list(transactions or []), None)]

    def get_transactions_by_date_range(self, account_id, start_date, end_date, limit=20, cursor=None):
        return self._queue.pop(0) if self._queue else ([], None)


class FakePayCycleRepo:
    def __init__(self, length=LENGTH, last_pay_date=PAYDATE):
        self._cycle = {"length": length, "last_pay_date": last_pay_date}

    def get_paycycle(self):
        return dict(self._cycle)


class FakeCategoryRepo:
    def __init__(self, categories=None):
        self._categories = categories if categories is not None else _spend_cat()

    def list_categories(self):
        return [dict(c) for c in self._categories]


def _spend_cat(cat_id="insurance", bucket="Living"):
    return [{"id": cat_id, "bucket": bucket, "parent": None}]


def _txn(category, amount, date, status="posted"):
    return {"category": category, "amount": Decimal(str(amount)), "status": status,
            "date": date, "counts_to_budget": True}


def _entry(spread_from, amount=BILL, cycles=4, spread_len=LENGTH, target=250):
    return {
        "target": Decimal(target), "spread_amount": amount, "spread_cycles": Decimal(cycles),
        "spread_from": spread_from, "spread_len": Decimal(spread_len), "spread_paydate": PAYDATE,
    }


def _list(handler, budget_repo, transactions=None, categories=None):
    return handler.list_budgets(
        budget_repo, FakeTransactionRepo(transactions), FakePayCycleRepo(), FakeCategoryRepo(categories))


@pytest.fixture(autouse=True)
def _fixed_window(handler, monkeypatch):
    monkeypatch.setattr(handler, "current_cycle_window",
                        lambda last_pay_date, length, today=None: (CYCLE_START, TODAY))


# --- GET /budgets: the cushion, then the slices, then nothing ------------------


def test_the_anchor_cycle_carries_the_full_bill_as_a_cushion(handler):
    # The bill landed this cycle: spent 1390.91 of a 250 target. The row reports the whole
    # bill as a positive adjustment, so the client's spendable (target + adjustment) covers it.
    budget_repo = FakeBudgetRepo({"insurance": _entry(spread_from=CYCLE_START)})
    result = _list(handler, budget_repo, [_txn("insurance", -1390.91, "2026-08-07")])

    assert result["insurance"]["posted"] == BILL
    assert result["insurance"]["spread"] == {"amount": BILL, "cycles": 4, "index": 0, "adjustment": BILL}
    assert budget_repo.clear_spread_calls == []     # an active plan is never cleared


def test_the_next_cycle_gives_back_the_first_slice(handler):
    budget_repo = FakeBudgetRepo({"insurance": _entry(spread_from="2026-07-07")})
    result = _list(handler, budget_repo)

    assert result["insurance"]["spread"] == {
        "amount": BILL, "cycles": 4, "index": 1, "adjustment": Decimal("-347.73")}
    assert budget_repo.clear_spread_calls == []


def test_the_last_payback_cycle_is_still_part_of_the_plan(handler):
    # index == cycles: the final (odd-cent) slice is taken and the plan is NOT yet cleared.
    # FAIL-ON-REVERT for an off-by-one that would finish the plan a cycle early.
    budget_repo = FakeBudgetRepo({"insurance": _entry(spread_from="2026-04-08")})
    result = _list(handler, budget_repo)

    assert result["insurance"]["spread"]["index"] == 4
    assert result["insurance"]["spread"]["adjustment"] == Decimal("-347.72")
    assert budget_repo.clear_spread_calls == []


def test_a_finished_plan_shows_nothing_and_is_cleared_best_effort(handler):
    # index == cycles + 1: every slice has been taken. The row is byte-identical to a plain
    # budget (no `spread` key) and the stale fields are cleared on this read.
    budget_repo = FakeBudgetRepo({"insurance": _entry(spread_from="2026-03-09")})
    result = _list(handler, budget_repo)

    assert result["insurance"] == {"target": Decimal(250), "posted": Decimal(0), "pending": Decimal(0)}
    assert budget_repo.clear_spread_calls == ["insurance"]


def test_a_long_gap_read_finishes_a_max_length_plan_instead_of_draining_forever(handler):
    # FAIL-ON-REVERT for the saturation bug: a plan over the max 24 cycles, first opened ~31
    # cycles later. A position derived from the CAPPED window list would pin at 24 == cycles
    # and keep taking a slice every read, forever. The direct count sees it as finished.
    budget_repo = FakeBudgetRepo({"insurance": _entry(spread_from="2024-01-01", cycles=24)})
    result = _list(handler, budget_repo)

    assert "spread" not in result["insurance"]
    assert budget_repo.clear_spread_calls == ["insurance"]


# --- pay-cycle change mid-plan: settle up in one hit, stay net-zero -------------


def test_a_pay_cycle_change_settles_the_outstanding_balance_over_this_cycle_then_closes(handler, monkeypatch):
    # $300 over 6 (fortnightly) cycles, anchored 2026-05-08 under length 14; the user is now
    # monthly. Under its own grid the plan had reached index 6 by today, so the 5 slices
    # shown for full cycles (5 x $50) count as taken; the $50 still owed comes off THIS
    # cycle. Net: +300 - 250 - 50 == 0 — nothing forgiven, nothing invented.
    original = Decimal("300.00")
    budget_repo = FakeBudgetRepo({"insurance": _entry(
        spread_from="2026-05-08", amount=original, cycles=6, spread_len=14)})
    result = _list(handler, budget_repo)

    # The row is the settle plan itself: $50 over 1 cycle, at index 1 (all of it, now).
    assert result["insurance"]["spread"] == {
        "amount": Decimal("50.00"), "cycles": 1, "index": 1, "adjustment": Decimal("-50.00")}
    taken_before = -sum((handler.spread_adjustment(original, 6, k) for k in range(1, 6)), Decimal(0))
    assert original - taken_before + result["insurance"]["spread"]["adjustment"] == 0
    # It is PERSISTED as a fresh one-cycle plan anchored one cycle back on the new grid —
    # not shown once and cleared. FAIL-ON-REVERT for the settle surviving past one read.
    assert budget_repo.set_spread_calls == [("insurance", Decimal("50.00"), 1, "2026-07-07", LENGTH, PAYDATE)]
    assert budget_repo.clear_spread_calls == []

    second_read = _list(handler, budget_repo)   # same cycle, plan now re-anchored + aligned
    assert second_read["insurance"]["spread"]["adjustment"] == Decimal("-50.00")
    assert budget_repo.clear_spread_calls == []

    # Next cycle on the new grid: the settle plan is at index 2 of 1 -> finished, nothing
    # shown, cleared. The settle never lingers past the cycle it was owed in.
    monkeypatch.setattr(handler, "current_cycle_window",
                        lambda last_pay_date, length, today=None: ("2026-09-05", "2026-09-06"))
    third_read = _list(handler, budget_repo)
    assert "spread" not in third_read["insurance"]
    assert budget_repo.clear_spread_calls == ["insurance"]


def test_taken_slices_are_measured_by_what_was_shown_under_the_old_grid_not_the_new_start(handler):
    # The bill (1390.91 over 4) was anchored 2026-06-09 under a grid paid 2026-01-10: cycles
    # 06-09, 07-09, 08-08. By today (08-10) the user has been shown slice 1 (-347.73) for
    # the WHOLE 07-09..08-07 cycle and is on slice 2. They now correct the payday to 01-01,
    # so the new cycle start is 08-06 — a day inside that completed old cycle. Counting
    # taken slices against the new start would un-take slice 1 and settle the whole bill
    # (charging slice 1 twice). Measured against today under the old grid: 1 taken, so
    # outstanding = 1390.91 - 347.73 = 1043.18. FAIL-ON-REVERT for using today, not cycle_start.
    entry = _entry(spread_from="2026-06-09")
    entry["spread_paydate"] = "2026-01-10"
    budget_repo = FakeBudgetRepo({"insurance": entry})
    result = _list(handler, budget_repo)

    assert result["insurance"]["spread"] == {
        "amount": Decimal("1043.18"), "cycles": 1, "index": 1, "adjustment": Decimal("-1043.18")}
    assert budget_repo.set_spread_calls == [("insurance", Decimal("1043.18"), 1, "2026-07-07", LENGTH, PAYDATE)]
    slice_one = -handler.spread_adjustment(BILL, 4, 1)
    assert BILL - slice_one + result["insurance"]["spread"]["adjustment"] == 0


def test_a_second_pay_cycle_change_re_settles_the_settle_plan_instead_of_forgiving_it(handler):
    # A persisted settle plan ($50 over 1, anchored 2026-07-09 under a grid paid 01-03) is hit
    # by ANOTHER payday fix (to 01-01, cycle start 08-06 — before its anchor). Its index
    # under its own grid today is 1 (owed now, not yet shown for a full cycle), so it is
    # re-settled as -50 on the new grid — never treated as "still in the anchor cycle" and
    # forgiven. FAIL-ON-REVERT for the same today-vs-cycle_start measure.
    entry = _entry(spread_from="2026-07-09", amount=Decimal("50.00"), cycles=1)
    entry["spread_paydate"] = "2026-01-03"
    budget_repo = FakeBudgetRepo({"insurance": entry})
    result = _list(handler, budget_repo)

    assert result["insurance"]["spread"]["adjustment"] == Decimal("-50.00")
    assert budget_repo.set_spread_calls == [("insurance", Decimal("50.00"), 1, "2026-07-07", LENGTH, PAYDATE)]
    assert budget_repo.clear_spread_calls == []


def test_a_pay_cycle_change_while_still_in_the_anchor_cycle_just_withdraws_the_cushion(handler):
    # The cushion and the settle-up would land in the same cycle and cancel, so nothing is
    # shown (the row is plain) and the plan closes. Net zero by construction.
    budget_repo = FakeBudgetRepo({"insurance": _entry(spread_from=CYCLE_START, spread_len=14)})
    result = _list(handler, budget_repo)

    assert "spread" not in result["insurance"]
    assert budget_repo.clear_spread_calls == ["insurance"]


def test_a_payday_moved_backwards_within_the_anchor_cycle_is_not_a_debt(handler):
    # The user set their payday a few days EARLIER while still in the cycle the plan was
    # created in (anchor 2026-08-08, today 08-10): under its own grid the plan is still at
    # index 0, so the cushion and the settle cancel — never "claw the whole bill back this
    # cycle". The new cycle_start (08-06) sitting BEFORE the anchor must not matter.
    entry = _entry(spread_from="2026-08-08")
    entry["spread_paydate"] = "2026-01-03"
    budget_repo = FakeBudgetRepo({"insurance": entry})
    result = _list(handler, budget_repo)

    assert "spread" not in result["insurance"]
    assert budget_repo.clear_spread_calls == ["insurance"]


def test_a_pay_cycle_change_after_every_slice_was_taken_owes_nothing(handler):
    # 2 cycles of $150, anchored far back under length 14: all slices long taken, so there is
    # nothing to settle — no adjustment, just the clear.
    budget_repo = FakeBudgetRepo({"insurance": _entry(
        spread_from="2025-01-01", amount=Decimal("300.00"), cycles=2, spread_len=14)})
    result = _list(handler, budget_repo)

    assert "spread" not in result["insurance"]
    assert budget_repo.clear_spread_calls == ["insurance"]


def test_a_payday_change_alone_also_counts_as_a_cycle_change(handler):
    # Same length, different payday: the grid moved, so the plan settles + closes rather
    # than reading slices off a fictional grid (mirrors the rollover alignment rule).
    entry = _entry(spread_from="2026-07-07")
    entry["spread_paydate"] = "2026-01-03"
    budget_repo = FakeBudgetRepo({"insurance": entry})
    result = _list(handler, budget_repo)

    # One old cycle elapsed -> no slice was ever fully taken, so the WHOLE bill settles now,
    # re-saved as a one-cycle plan on the new grid.
    assert result["insurance"]["spread"] == {"amount": BILL, "cycles": 1, "index": 1, "adjustment": -BILL}
    assert budget_repo.set_spread_calls == [("insurance", BILL, 1, "2026-07-07", LENGTH, PAYDATE)]
    assert budget_repo.clear_spread_calls == []


# --- scope + robustness ---------------------------------------------------------


def test_a_spread_on_a_re_bucketed_income_category_is_ignored(handler):
    # The plan was set while the category was spend; it's now Income. The read ignores it
    # (no adjustment on an earn-target) and does not clear it either — the reclassify path
    # owns that; a stale plan is inert here.
    budget_repo = FakeBudgetRepo({"insurance": _entry(spread_from=CYCLE_START)})
    result = _list(handler, budget_repo, categories=_spend_cat(bucket="Income"))

    assert "spread" not in result["insurance"]
    assert budget_repo.clear_spread_calls == []


def test_a_plain_budget_row_is_byte_identical_to_before(handler):
    budget_repo = FakeBudgetRepo({"food": {"target": Decimal(250)}})
    result = _list(handler, budget_repo, [_txn("food", -40, "2026-08-08")], _spend_cat("food"))

    assert result == {"food": {"target": Decimal(250), "posted": Decimal(40), "pending": Decimal(0)}}


def test_a_failed_clear_never_500s_the_read(handler):
    budget_repo = FakeBudgetRepo({"insurance": _entry(spread_from="2026-03-09")})
    budget_repo.clear_spread_raises = True
    result = _list(handler, budget_repo)

    assert "spread" not in result["insurance"]          # still served
    assert budget_repo.clear_spread_calls == ["insurance"]   # it did attempt the clear


def test_a_partial_spread_entry_is_cleared_instead_of_500ing_the_whole_screen(handler):
    # Every write sets/strips all five fields together, so a partial entry can only come from
    # a hand-edited item. It must not KeyError the read — one bad entry would take down every
    # budget row. It is treated as finished: nothing shown, cleared, the sibling row served.
    budget_repo = FakeBudgetRepo({
        "insurance": {"target": Decimal(250), "spread_amount": BILL, "spread_from": CYCLE_START},
        "food": {"target": Decimal(80)},
    })
    result = _list(handler, budget_repo, categories=_spend_cat() + _spend_cat("food"))

    assert result["insurance"] == {"target": Decimal(250), "posted": Decimal(0), "pending": Decimal(0)}
    assert result["food"]["target"] == Decimal(80)
    assert budget_repo.clear_spread_calls == ["insurance"]


def test_the_handlers_spread_field_list_matches_the_repositorys(handler):
    # GUARD: the read trusts an entry only when it has every field in _SPREAD_ENTRY_FIELDS;
    # the repo writes/strips _SPREAD_FIELDS. If one gains a field the other doesn't, a
    # freshly-written plan would read as "partial" and be cleared on its first read.
    import repository_budget

    assert set(handler._SPREAD_ENTRY_FIELDS) == set(repository_budget._SPREAD_FIELDS)


# --- PUT /budgets/{category}/spread ---------------------------------------------


def _put_spread_event(category="insurance", body='{"amount": 1390.91, "cycles": 4}'):
    return {
        "rawPath": f"/budgets/{category}/spread",
        "requestContext": {"http": {"method": "PUT"}},
        "pathParameters": {"category": category},
        "body": body,
        "isBase64Encoded": False,
    }


def _delete_spread_event(category="insurance"):
    return {
        "rawPath": f"/budgets/{category}/spread",
        "requestContext": {"http": {"method": "DELETE"}},
        "pathParameters": {"category": category},
    }


def _budgeted(**extra):
    return FakeBudgetRepo({"insurance": {"target": Decimal(250), **extra}})


def test_set_spread_records_the_plan_anchored_to_the_current_cycle(handler):
    repo = _budgeted()

    resp = handler.set_spread(_put_spread_event(), repo, FakeCategoryRepo(), FakePayCycleRepo())

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"id": "insurance", "amount": 1390.91, "cycles": 4}
    assert repo.set_spread_calls == [("insurance", Decimal("1390.91"), 4, CYCLE_START, LENGTH, PAYDATE)]


def test_set_spread_quantises_the_amount_to_cents(handler):
    # The slices are split in whole cents, so the stored amount must be a whole number of
    # cents or the slices could never sum back to it. FAIL-ON-REVERT for the quantize.
    repo = _budgeted()

    handler.set_spread(_put_spread_event(body='{"amount": 33.333, "cycles": 3}'), repo,
                       FakeCategoryRepo(), FakePayCycleRepo())

    stored_amount = repo.set_spread_calls[0][1]
    assert stored_amount == Decimal("33.33")
    assert stored_amount.as_tuple().exponent == -2


@pytest.mark.parametrize("body", [
    '{"cycles": 4}',                          # amount missing
    '{"amount": "1390.91", "cycles": 4}',     # amount as a string
    '{"amount": true, "cycles": 4}',          # bool is an int subclass — reject explicitly
    '{"amount": NaN, "cycles": 4}',           # json.loads accepts NaN; DynamoDB does not
    '{"amount": 0, "cycles": 4}',             # nothing to spread
    '{"amount": 0.004, "cycles": 4}',         # rounds to $0.00 — nothing to spread either
    '{"amount": -50, "cycles": 4}',
    '{"amount": 1000000001, "cycles": 4}',    # over _BUDGET_TARGET_MAX
    '{"amount": 1e27, "cycles": 4}',          # finite but past Decimal's 28 digits — a clean 400, not a 500
    '{"amount": 100}',                        # cycles missing
    '{"amount": 100, "cycles": 2.5}',         # not a whole number
    '{"amount": 100, "cycles": true}',
    '{"amount": 100, "cycles": 0}',           # below SPREAD_MIN_CYCLES
    '{"amount": 100, "cycles": 25}',          # above SPREAD_MAX_CYCLES
])
def test_set_spread_rejects_a_bad_body_400(handler, body):
    repo = _budgeted()

    resp = handler.set_spread(_put_spread_event(body=body), repo, FakeCategoryRepo(), FakePayCycleRepo())

    assert resp["statusCode"] == 400
    assert repo.set_spread_calls == []


@pytest.mark.parametrize("bound", ["SPREAD_MIN_CYCLES", "SPREAD_MAX_CYCLES"])
def test_set_spread_accepts_the_cycle_bounds_inclusive(handler, bound):
    cycles = getattr(handler, bound)
    repo = _budgeted()

    resp = handler.set_spread(_put_spread_event(body=f'{{"amount": 100, "cycles": {cycles}}}'),
                              repo, FakeCategoryRepo(), FakePayCycleRepo())

    assert resp["statusCode"] == 200
    assert repo.set_spread_calls[0][2] == cycles


@pytest.mark.parametrize("bucket", ["Income", "Savings"])
def test_set_spread_rejects_a_non_spend_category_400(handler, bucket):
    repo = _budgeted()

    resp = handler.set_spread(_put_spread_event(), repo, FakeCategoryRepo(_spend_cat(bucket=bucket)),
                              FakePayCycleRepo())

    assert resp["statusCode"] == 400
    assert repo.set_spread_calls == []


def test_set_spread_requires_a_budget_target_first(handler):
    # The spread adjusts a target's cycle spendable; with no target there is nothing to adjust.
    repo = FakeBudgetRepo({})

    resp = handler.set_spread(_put_spread_event(), repo, FakeCategoryRepo(), FakePayCycleRepo())

    assert resp["statusCode"] == 400
    assert "budget" in json.loads(resp["body"])["error"]
    assert repo.set_spread_calls == []


def test_set_spread_is_rejected_while_rollover_is_on(handler):
    # Mutual exclusion, direction 1: both would move the same cycle's spendable and count
    # one overspend twice. FAIL-ON-REVERT for the guard.
    repo = _budgeted(rollover=True)

    resp = handler.set_spread(_put_spread_event(), repo, FakeCategoryRepo(), FakePayCycleRepo())

    assert resp["statusCode"] == 400
    assert "rollover" in json.loads(resp["body"])["error"]
    assert repo.set_spread_calls == []


def test_turning_rollover_on_is_rejected_while_a_spread_is_active(handler):
    # Mutual exclusion, direction 2: the mirror guard on PUT /budgets/{id}.
    repo = _budgeted(spread_amount=BILL, spread_cycles=Decimal(4), spread_from=CYCLE_START,
                     spread_len=Decimal(LENGTH), spread_paydate=PAYDATE)
    event = {
        "rawPath": "/budgets/insurance",
        "requestContext": {"http": {"method": "PUT"}},
        "pathParameters": {"category": "insurance"},
        "body": '{"target": 250, "rollover": true}',
        "isBase64Encoded": False,
    }

    resp = handler.set_budget(event, repo, FakeCategoryRepo(), FakePayCycleRepo())

    assert resp["statusCode"] == 400
    assert "spread" in json.loads(resp["body"])["error"]
    assert repo.set_calls == []


def test_a_plain_target_edit_is_still_allowed_while_a_spread_is_active(handler):
    # Only the rollover flag is guarded; changing the amount with a spread on is fine.
    repo = _budgeted(spread_amount=BILL, spread_cycles=Decimal(4), spread_from=CYCLE_START,
                     spread_len=Decimal(LENGTH), spread_paydate=PAYDATE)
    event = {
        "rawPath": "/budgets/insurance",
        "requestContext": {"http": {"method": "PUT"}},
        "pathParameters": {"category": "insurance"},
        "body": '{"target": 300}',
        "isBase64Encoded": False,
    }

    resp = handler.set_budget(event, repo, FakeCategoryRepo(), FakePayCycleRepo())

    assert resp["statusCode"] == 200
    assert repo.set_calls == [("insurance", Decimal(300))]


def test_set_spread_missing_path_param_404(handler):
    repo = _budgeted()

    resp = handler.set_spread({"pathParameters": {}, "body": "{}"}, repo, FakeCategoryRepo(), FakePayCycleRepo())

    assert resp["statusCode"] == 404
    assert repo.set_spread_calls == []


# --- DELETE /budgets/{category}/spread ------------------------------------------


def test_delete_spread_clears_the_plan(handler):
    repo = _budgeted(spread_amount=BILL)

    resp = handler.delete_spread(_delete_spread_event(), repo)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"id": "insurance"}
    assert repo.clear_spread_calls == ["insurance"]


def test_delete_spread_is_idempotent_200_with_no_plan(handler):
    repo = FakeBudgetRepo({})

    resp = handler.delete_spread(_delete_spread_event(category="never_spread"), repo)

    assert resp["statusCode"] == 200
    assert repo.clear_spread_calls == ["never_spread"]


def test_delete_spread_missing_path_param_404(handler):
    resp = handler.delete_spread({"pathParameters": {}}, FakeBudgetRepo())

    assert resp["statusCode"] == 404


# --- routing: the /spread suffix must not fall into the item PUT/DELETE --------


def test_put_spread_routes_to_set_spread_not_set_budget(handler, monkeypatch):
    # FAIL-ON-REVERT for the router ordering: without the exact-suffix branch, the generic
    # `PUT /budgets/{id}` would swallow this and try to parse a `target`.
    repo = _budgeted()
    monkeypatch.setattr(handler, "BudgetRepository", lambda: repo)
    monkeypatch.setattr(handler, "CategoryRepository", lambda: FakeCategoryRepo())
    monkeypatch.setattr(handler, "PayCycleRepository", lambda: FakePayCycleRepo())

    resp = handler.lambda_handler(_put_spread_event(), None)

    assert resp["statusCode"] == 200
    assert repo.set_spread_calls != []
    assert repo.set_calls == []


def test_delete_spread_routes_to_delete_spread_not_delete_budget(handler, monkeypatch):
    repo = _budgeted(spread_amount=BILL)
    monkeypatch.setattr(handler, "BudgetRepository", lambda: repo)

    resp = handler.lambda_handler(_delete_spread_event(), None)

    assert resp["statusCode"] == 200
    assert repo.clear_spread_calls == ["insurance"]
    assert repo.delete_calls == []          # the budget target itself is untouched


def test_a_category_whose_id_is_literally_spread_still_reaches_the_item_routes(handler, monkeypatch):
    # "/budgets/spread" is the ITEM route for a category slugged "spread" (a plausible
    # name). A bare suffix match would steal it: PUT would land in set_spread (400, no
    # `amount`) and DELETE in delete_spread (target never removed). FAIL-ON-REVERT for the
    # exact-three-segment guard.
    repo = FakeBudgetRepo({"spread": {"target": Decimal(50)}})
    monkeypatch.setattr(handler, "BudgetRepository", lambda: repo)
    monkeypatch.setattr(handler, "CategoryRepository", lambda: FakeCategoryRepo(_spend_cat("spread")))
    monkeypatch.setattr(handler, "PayCycleRepository", lambda: FakePayCycleRepo())

    put = handler.lambda_handler({
        "rawPath": "/budgets/spread", "requestContext": {"http": {"method": "PUT"}},
        "pathParameters": {"category": "spread"}, "body": '{"target": 60}', "isBase64Encoded": False,
    }, None)
    delete = handler.lambda_handler({
        "rawPath": "/budgets/spread", "requestContext": {"http": {"method": "DELETE"}},
        "pathParameters": {"category": "spread"},
    }, None)

    assert put["statusCode"] == 200
    assert repo.set_calls == [("spread", Decimal(60))]
    assert repo.set_spread_calls == []
    assert delete["statusCode"] == 200
    assert repo.delete_calls == ["spread"]
    assert repo.clear_spread_calls == []


def test_the_spread_routes_are_registered_in_api_gateway():
    # The gateway lists every route explicitly (no greedy proxy): a handler branch with no
    # matching route key 404s before the Lambda is ever invoked.
    import pathlib

    tf = (pathlib.Path(__file__).resolve().parents[2] / "terraform" / "apigateway.tf").read_text()
    assert '"PUT /budgets/{category}/spread"' in tf
    assert '"DELETE /budgets/{category}/spread"' in tf
