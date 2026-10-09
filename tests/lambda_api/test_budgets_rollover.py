"""Tests for budget ROLLOVER (envelope carryover) in GET /budgets.

A rollover category accumulates each cycle's leftover (target - spend) into a signed
`carryover` buffer: a sinking fund builds up until a bill lands, a spike cycle carries its
overspend as a deficit. The buffer is sealed lazily on read (write-on-read, best-effort):
completed cycles older than the settle lag fold into the stored balance; the recent unsealed
cycles are recomputed live. These tests pin that flow.

`handler.current_cycle_window` is monkeypatched to a fixed (cycle_start, today) so the cycle
math is deterministic (the real one reads the wall clock). The pure stepping helper
`completed_cycle_windows` is exercised directly in tests/shared/test_spend_windows.py.
"""

import pathlib
from decimal import Decimal
from functools import partial

import pytest

from _api_event import api_event
from _budget_endpoint_fakes import CYCLE_START, LENGTH, PAYDATE, _FakeCategoryRepo, _FakePayCycleRepo, pin_cycle_window
from _budget_fakes import recording_budget_repo
from _lambda_api_constants import constants_namespace
from _transaction_range_fakes import _QueuedTransactionRepo

pytestmark = pytest.mark.usefixtures("fixed_window")

# A fixed monthly cycle: current cycle_start 2026-08-06, today 2026-08-10 (4 days in), payday
# grid anchored at 2026-01-01. The settle lag is 10 days, so the cutoff is 2026-07-31: a
# completed cycle whose end is before that seals; a more recent one stays live.
_ROOT = pathlib.Path(__file__).resolve().parents[2]


FakePayCycleRepo = partial(_FakePayCycleRepo, length=LENGTH, last_pay_date=PAYDATE)


def _txn(category, amount, date, status="posted", counts=True):
    return {"category": category, "amount": Decimal(str(amount)), "status": status,
            "date": date, "counts_to_budget": counts}


def _spend_cat(cat_id="sink", bucket="Lifestyle", parent=None):
    return [{"id": cat_id, "bucket": bucket, "parent": parent}]


def _entry(target, **extra):
    entry = {"target": Decimal(str(target)), "rollover": True,
             "carryover_len": Decimal(LENGTH), "carryover_paydate": PAYDATE}
    entry.update(extra)
    return entry


# --- sinking fund: unused budget accumulates ---------------------------------


def test_empty_cycles_accumulate_into_the_buffer_and_seal_the_settled_ones(handler):
    # Anchor 3 cycles back (2026-05-08), all empty, target 100/cycle. Two oldest cycles are
    # older than the 10-day lag -> sealed (200); the most recent completed cycle is still live
    # (+100). Displayed carryover = 300; the seal advances the anchor past the two sealed cycles.
    budget_repo = recording_budget_repo({"sink": _entry(100, carryover=Decimal(0), carryover_from="2026-05-08")})
    result = handler.list_budgets(budget_repo, _QueuedTransactionRepo(), FakePayCycleRepo(), _FakeCategoryRepo(_spend_cat()))

    assert result["sink"]["rollover"] is True
    assert result["sink"]["carryover"] == Decimal(300)
    # Only the two lag-cleared cycles were sealed into the stored balance (200), anchor -> the
    # start of the still-live cycle (2026-07-07).
    assert budget_repo.settle_calls == [("sink", Decimal(200), "2026-07-07", LENGTH, PAYDATE)]


# --- spike / borrow: overspend carries as a deficit --------------------------


def test_overspend_in_the_live_cycle_carries_as_a_negative_buffer_without_sealing(handler):
    # Anchor one cycle back (2026-07-07): that completed cycle is still within the lag (ends
    # 2026-08-05), so it is NOT sealed. A $150 spend against target 100 => leftover -50, shown
    # live as a -50 buffer. Nothing seals, so the anchor doesn't move and no settle is written.
    budget_repo = recording_budget_repo({"sink": _entry(100, carryover=Decimal(0), carryover_from="2026-07-07")})
    txns = _QueuedTransactionRepo([_txn("sink", -150, "2026-07-20")])  # in the completed (unsealed) cycle
    result = handler.list_budgets(budget_repo, txns, FakePayCycleRepo(), _FakeCategoryRepo(_spend_cat()))

    assert result["sink"]["carryover"] == Decimal(-50)
    # The widened fetch is sliced back to the current cycle for posted/pending: the prior-cycle
    # spend must NOT leak into current-cycle posted (fail-on-revert for the `current` slice).
    assert result["sink"]["posted"] == Decimal(0)
    assert budget_repo.settle_calls == []   # unsealed -> no write


# --- pay-cycle change re-anchors (freezes) instead of double-counting --------


def test_a_pay_cycle_length_change_freezes_the_buffer_and_re_anchors(handler):
    # Buffer was sealed under a 14-day cycle; the user is now monthly (30). The stored anchor
    # is fictional against the new grid, so freeze the balance (40) and re-anchor to the
    # current cycle_start under the new length — no cycles are folded this read.
    budget_repo = recording_budget_repo({"sink": {
        "target": Decimal(100), "rollover": True, "carryover": Decimal(40),
        "carryover_from": "2026-05-08", "carryover_len": Decimal(14), "carryover_paydate": PAYDATE,
    }})
    result = handler.list_budgets(budget_repo, _QueuedTransactionRepo(), FakePayCycleRepo(), _FakeCategoryRepo(_spend_cat()))

    assert result["sink"]["carryover"] == Decimal(40)   # frozen, not re-folded
    assert budget_repo.settle_calls == [("sink", Decimal(40), CYCLE_START, LENGTH, PAYDATE)]


# --- scope: rollover is spend-only -------------------------------------------


def test_rollover_flag_on_a_re_bucketed_income_category_is_ignored(handler):
    # The flag was set while the category was spend; it was later re-bucketed to Income. On
    # read it falls through to the plain earn-target output (no rollover/carryover keys), and
    # nothing is sealed — earnings must never fold into a spend buffer.
    budget_repo = recording_budget_repo({"sink": _entry(100, carryover=Decimal(0), carryover_from="2026-05-08")})
    result = handler.list_budgets(budget_repo, _QueuedTransactionRepo(), FakePayCycleRepo(),
                                  _FakeCategoryRepo(_spend_cat(bucket="Income")))

    assert "rollover" not in result["sink"]
    assert "carryover" not in result["sink"]
    assert budget_repo.settle_calls == []


# --- robustness --------------------------------------------------------------


def test_a_failed_settle_write_never_500s_the_read(handler):
    # The seal write is best-effort: even if settle_carryover raises, the live carryover is
    # still computed and returned (it just re-seals on the next read).
    budget_repo = recording_budget_repo({"sink": _entry(100, carryover=Decimal(0), carryover_from="2026-05-08")})
    budget_repo._table.fail("update_item")
    result = handler.list_budgets(budget_repo, _QueuedTransactionRepo(), FakePayCycleRepo(), _FakeCategoryRepo(_spend_cat()))

    assert result["sink"]["carryover"] == Decimal(300)   # displayed regardless of the write
    assert budget_repo.settle_calls != []                # it did attempt the write


def test_settlement_is_bounded_by_the_max_lookback_cap(handler):
    # Anchor 20 empty cycles back but the cap is 12 -> only 12 are folded (12 * 100 = 1200),
    # NOT 2000; the older leftovers are dropped and the anchor jumps forward. Fail-on-revert
    # for the cold-start bound: without the cap this would read 2000.
    old_anchor = "2025-01-09"  # ~20 monthly cycles before 2026-08-06
    budget_repo = recording_budget_repo({"sink": _entry(100, carryover=Decimal(0), carryover_from=old_anchor)})
    result = handler.list_budgets(budget_repo, _QueuedTransactionRepo(), FakePayCycleRepo(), _FakeCategoryRepo(_spend_cat()))

    assert result["sink"]["carryover"] == Decimal(1200)


# --- settle-lag EXACT boundary ------------------------------------------------


@pytest.mark.parametrize("today, settle_calls", [
    # cutoff = today-10 = 2026-08-05: the completed cycle [2026-07-07, 2026-08-05] ends EXACTLY
    # on it. The seal test is a strict `<`, so it stays live (recomputed each read).
    ("2026-08-15", []),
    # cutoff 2026-08-06: the same cycle now ends strictly before it, so it seals and the anchor
    # advances to the next cycle start. The boundary is exactly one day wide.
    ("2026-08-16", [("sink", Decimal(100), "2026-08-06", LENGTH, PAYDATE)]),
])
def test_the_lag_cutoff_seals_only_cycles_ending_strictly_before_it(handler, monkeypatch, today, settle_calls):
    pin_cycle_window(handler, monkeypatch, "2026-08-06", today)
    budget_repo = recording_budget_repo({"sink": _entry(100, carryover=Decimal(0), carryover_from="2026-07-07")})
    result = handler.list_budgets(budget_repo, _QueuedTransactionRepo(), FakePayCycleRepo(),
                                  _FakeCategoryRepo(_spend_cat()))

    assert result["sink"]["carryover"] == Decimal(100)
    assert budget_repo.settle_calls == settle_calls


# --- SUBTREE sealing: a parent's sealed leftover folds its children -----------


def test_a_parents_sealed_leftover_folds_child_spend_across_the_subtree(handler, monkeypatch):
    # A budgeted PARENT (food, target 100) with rollover; a child (dining) carries no target of
    # its own. In a SEALED past cycle the child spent 30. The sealed leftover must be 100-30=70,
    # not 100 — _seal_rollover has to fold the whole subtree per cycle, exactly as the current
    # window does. Fail-on-revert: sealing on {parent} only would read 100 sealed / carryover 200.
    pin_cycle_window(handler, monkeypatch, "2026-08-06", "2026-08-10")   # cutoff 2026-07-31
    budget_repo = recording_budget_repo({"food": _entry(100, carryover=Decimal(0), carryover_from="2026-06-07")})
    cats = _FakeCategoryRepo(_spend_cat("food") + _spend_cat("dining", parent="food"))
    # dining spend lands in the sealed cycle [2026-06-07, 2026-07-06]; the live cycle is empty.
    txns = _QueuedTransactionRepo([_txn("dining", -30, "2026-06-20")])
    result = handler.list_budgets(budget_repo, txns, FakePayCycleRepo(), cats)

    assert result["food"]["carryover"] == Decimal(170)   # sealed 70 + live 100
    assert budget_repo.settle_calls == [("food", Decimal(70), "2026-07-07", LENGTH, PAYDATE)]
    # The past child spend is NOT in the current cycle, so the bar shows 0 spent this cycle.
    assert result["food"]["posted"] == Decimal(0)


# --- refund in a sealed cycle: per-cycle spend floors at 0 -------------------


def test_a_refund_in_a_sealed_cycle_cannot_push_leftover_above_target(handler, monkeypatch):
    # A net refund in a past cycle drives that cycle's spend negative, but fold_subtree clamps
    # per-cycle spend at >= 0, so the sealed leftover caps at the target (100), never 150. Pins
    # the aggregate-then-clamp rule for sealing. (A user-visible surprise — see the critique.)
    pin_cycle_window(handler, monkeypatch, "2026-08-06", "2026-08-10")   # cutoff 2026-07-31
    budget_repo = recording_budget_repo({"sink": _entry(100, carryover=Decimal(0), carryover_from="2026-06-07")})
    # +50 amount with the default spend sign is a refund (negative contribution) in the sealed cycle.
    txns = _QueuedTransactionRepo([_txn("sink", 50, "2026-06-20")])
    result = handler.list_budgets(budget_repo, txns, FakePayCycleRepo(), _FakeCategoryRepo(_spend_cat()))

    assert result["sink"]["carryover"] == Decimal(200)   # sealed 100 (capped) + live 100, NOT 250
    assert budget_repo.settle_calls == [("sink", Decimal(100), "2026-07-07", LENGTH, PAYDATE)]


# --- current-cycle slice boundary: a txn dated exactly cycle_start is current -


def test_a_transaction_dated_exactly_on_cycle_start_is_current_not_sealed(handler, monkeypatch):
    # A spend dated EXACTLY on cycle_start (2026-08-06) must count as this cycle's posted spend,
    # never leak back into the just-completed cycle [2026-07-07, 2026-08-05]. The completed
    # windows are end-inclusive to 08-05, and the current slice is [cycle_start, today]. Fail-on-
    # revert: an off-by-one that bucketed 08-06 into the live cycle would drop posted to 0 and
    # shrink that cycle's leftover.
    pin_cycle_window(handler, monkeypatch, "2026-08-06", "2026-08-10")   # cutoff 2026-07-31
    budget_repo = recording_budget_repo({"sink": _entry(100, carryover=Decimal(0), carryover_from="2026-06-07")})
    # A spend in a PAST sealed cycle (25) + a spend dated exactly cycle_start (40). Only the
    # cycle_start one is this cycle's posted spend; the past one belongs to the sealed cycle,
    # so it must NOT inflate `posted`. Without the current-cycle slice, posted would read 65.
    txns = _QueuedTransactionRepo([
        _txn("sink", -25, "2026-06-20"),   # sealed cycle [2026-06-07, 2026-07-06]
        _txn("sink", -40, "2026-08-06"),   # exactly cycle_start -> current
    ])
    result = handler.list_budgets(budget_repo, txns, FakePayCycleRepo(), _FakeCategoryRepo(_spend_cat()))

    assert result["sink"]["posted"] == Decimal(40)       # ONLY the cycle_start spend, not the past 25
    # sealed cycle leftover 100-25=75, live cycle empty +100 -> carryover 175.
    assert result["sink"]["carryover"] == Decimal(175)
    assert budget_repo.settle_calls == [("sink", Decimal(75), "2026-07-07", LENGTH, PAYDATE)]


# --- PUT /budgets rollover: anchor + validation gaps -------------------------


def _put_budget_event(category="coffee", body=None):
    return api_event(
        "PUT",
        f"/budgets/{category}",
        raw=body if body is not None else '{"target": 60}',
        path_params={"category": category},
        is_base64=False,
    )


def test_turning_rollover_on_for_an_existing_budget_re_anchors_to_the_current_cycle(handler, monkeypatch):
    # OFF -> ON must (re)start accumulation at the current cycle: set_budget receives an anchor
    # carrying the CURRENT cycle_start + the live pay-cycle length/payday. Fail-on-revert:
    # dropping the anchor build leaves anchor=None and the buffer would seal the off-period.
    pin_cycle_window(handler, monkeypatch, "2026-08-06", "2026-08-10")
    repo = recording_budget_repo({"coffee": {"target": Decimal(50)}})   # exists, rollover OFF/unset
    resp = handler.set_budget(_put_budget_event(body='{"target": 60, "rollover": true}'),
                              repo, _FakeCategoryRepo(_spend_cat("coffee")), FakePayCycleRepo())

    assert resp["statusCode"] == 200
    assert repo.set_kwargs["rollover"] is True
    assert repo.set_kwargs["anchor"] == {
        "carryover_from": "2026-08-06", "carryover_len": Decimal(LENGTH), "carryover_paydate": PAYDATE,
    }


def test_an_amount_edit_while_rollover_already_on_does_not_re_anchor(handler, monkeypatch):
    # An amount edit that re-sends rollover:true while it is ALREADY on must NOT carry an anchor
    # (re-anchoring would drop a not-yet-sealed cycle). Fail-on-revert: if the OFF->ON guard were
    # removed, every amount edit would re-anchor and silently reset the settle window.
    pin_cycle_window(handler, monkeypatch, "2026-08-06", "2026-08-10")
    repo = recording_budget_repo({"coffee": {"target": Decimal(50), "rollover": True}})
    resp = handler.set_budget(_put_budget_event(body='{"target": 75, "rollover": true}'),
                              repo, _FakeCategoryRepo(_spend_cat("coffee")), FakePayCycleRepo())

    assert resp["statusCode"] == 200
    assert repo.set_kwargs["rollover"] is True
    assert repo.set_kwargs["anchor"] is None


def test_rollover_true_on_an_income_category_is_rejected_400(handler):
    # Rollover is spend-only: rollover:true on an Income earn-target is a 400 and is never written.
    repo = recording_budget_repo({})
    resp = handler.set_budget(_put_budget_event(body='{"target": 60, "rollover": true}'),
                              repo, _FakeCategoryRepo(_spend_cat("coffee", bucket="Income")), FakePayCycleRepo())

    assert resp["statusCode"] == 400
    assert repo.set_calls == []


def test_a_non_boolean_rollover_is_rejected_before_any_taxonomy_read(handler):
    # rollover must be a real bool — a truthy string like "yes" must 400, not be stored as-is.
    # The type check runs before the bucket read, so the taxonomy is never fetched.
    repo = recording_budget_repo({})
    cats = _FakeCategoryRepo(_spend_cat("coffee"))
    resp = handler.set_budget(_put_budget_event(body='{"target": 60, "rollover": "yes"}'),
                              repo, cats, FakePayCycleRepo())

    assert resp["statusCode"] == 400
    assert repo.set_calls == []


def test_explicit_rollover_false_is_forwarded_and_freezes_without_an_anchor(handler):
    # Turning rollover OFF forwards rollover=False (freezing the stored buffer) and never builds
    # an anchor. Fail-on-revert: if false were omitted instead of forwarded, the stored flag
    # wouldn't flip off.
    repo = recording_budget_repo({"coffee": {"target": Decimal(50), "rollover": True, "carryover": Decimal(40)}})
    resp = handler.set_budget(_put_budget_event(body='{"target": 50, "rollover": false}'),
                              repo, _FakeCategoryRepo(_spend_cat("coffee")), FakePayCycleRepo())

    assert resp["statusCode"] == 200
    assert repo.set_kwargs["rollover"] is False
    assert repo.set_kwargs["anchor"] is None


# --- constant drift guard ----------------------------------------------------


def test_rollover_settle_lag_equals_shared_pending_age_out():
    # The lag's VALUE must track PENDING_AGE_OUT_DAYS (the point past which a transaction can
    # no longer move). If the age-out window changes and this doesn't, the plan's rationale
    # silently breaks — this test fails first.
    shared = constants_namespace(_ROOT / "shared" / "constants.py")
    assert shared["ROLLOVER_SETTLE_LAG_DAYS"] == shared["PENDING_AGE_OUT_DAYS"]
