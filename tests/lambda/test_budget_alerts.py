"""Budget-threshold alert detection (lambda/budget_alerts.py), WHIT-22.

Driven through the webhook `lam` fixture (so budget_alerts + the real webhook repo
reconcile primitives are importable). `spend.melbourne_today` is pinned so the
cycle window is deterministic. `send_push` is stubbed to capture pushes.

The load-bearing test is `test_crossing_fires_via_delta_not_a_reread`: the fake
window repo returns ONLY the pre-write rows (it never sees the just-written row),
so the post-write spend level can only come from the in-memory replay — locking that the
alert is immune to the date-index GSI's eventual consistency.
"""

import inspect
from datetime import date
from decimal import Decimal
from functools import partial

import pytest
from _budget_alert_fakes import fail_nth_write, notify_repo, released_markers
from _budget_endpoint_fakes import _FakeCategoryRepo, _FakePayCycleRepo
from _dynamo_fakes import _client_error
from _transaction_range_fakes import _AccountPagesTransactionRepo, _AccountTransactionRepo

# Cycle: last_pay_date 2026-07-01, length 14, pinned "today" 2026-07-14 →
# window [2026-07-01, 2026-07-14]. All test transactions are dated inside it.
_TODAY = date(2026, 7, 14)
_ACCT = "up-spending"


@pytest.fixture
def alerts(lam, monkeypatch):
    import spend
    monkeypatch.setattr(spend, "melbourne_today", lambda: _TODAY)
    return lam


def _txn(txn_id, category, amount, status, date="2026-07-10"):
    """A normalised-transaction-like dict (models.Transaction is dict-like)."""
    return {
        "transaction_id": txn_id, "account_id": _ACCT, "category": category,
        "amount": Decimal(str(amount)), "status": status, "date": date,
        "counts_to_budget": True, "authorized_date": date,
    }


class FakeBudgetRepo:
    def __init__(self, budgets):
        self._b = budgets

    def list_budgets(self):
        return self._b


FakePaycycleRepo = partial(_FakePayCycleRepo, length=14, last_pay_date="2026-07-01")


class FakeDeviceRepo:
    def __init__(self, tokens=("ExpoPushToken[a]",)):
        self._t = list(tokens)

    def list_tokens(self):
        return list(self._t)


def _run(alerts, monkeypatch, *, budgets, before, normalised, tokens=("ExpoPushToken[a]",),
         cats=None, webhook_repo=None, notify=None, paycycle=("2026-07-01", 14), send_ok=1):
    ba = alerts.budget_alerts
    sent = []

    def fake_send(title, body, toks, data=None):
        sent.append((title, body, list(toks)))
        # send_ok models Expo acceptance: >0 = it reached Expo (the WHIT-154
        # mark-on-landing signal), 0 = a swallowed transport failure.
        return {"sent": len(list(toks)), "ok": send_ok, "pruned": []}

    monkeypatch.setattr(ba, "send_push", fake_send)
    notify = notify or notify_repo()
    ctx = ba.capture_pre_write(
        normalised,
        device_repo=FakeDeviceRepo(tokens),
        budget_repo=FakeBudgetRepo(budgets),
        paycycle_repo=FakePaycycleRepo(last_pay_date=paycycle[0], length=paycycle[1]),
        webhook_repo=_AccountTransactionRepo(before, pending_repo=webhook_repo),
    )
    ba.fire_budget_alerts(
        ctx, normalised, category_repo=_FakeCategoryRepo(cats or [{"id": "groceries", "name": "Groceries"}]),
        notify_repo=notify,
    )
    return sent, notify, ctx


def test_crossing_fires_via_delta_not_a_reread(alerts, monkeypatch):
    # before = $70 of $100 (0.70). The window repo returns ONLY that row — never the
    # new -$15. So after ($85, crossing 80%) can only come from the in-memory delta.
    before = [_txn("old", "groceries", -70, "posted")]
    new = _txn("new1", "groceries", -15, "posted")
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("100")}},
                           before=before, normalised=[new])
    assert len(sent) == 1
    title, body, toks = sent[0]
    assert title == "Heads up \U0001f440"
    assert body == "Groceries is at 80% of its budget this cycle."
    assert toks == ["ExpoPushToken[a]"]
    assert notify.fired_markers("2026-07-01", 14) == {"groceries#80"}


def test_pending_spend_counts_toward_the_threshold(alerts, monkeypatch):
    # A pending authorisation alone pushes spent+pending past 80%.
    new = _txn("p1", "groceries", -85, "pending")
    sent, _, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("100")}},
                      before=[], normalised=[new])
    assert len(sent) == 1


def test_income_clawback_does_not_fire_a_spend_alert(alerts, monkeypatch):
    # The load-bearing edge: a LONE negative amount (a payroll reversal) filed under an
    # income category flows through summarise_transactions as +positive spend (-(-4000)),
    # which would cross 80% of the 5000 target (4000 == 0.8*5000) if income weren't
    # excluded. The bucket exclusion is what keeps this silent — revert it and this fires.
    new = _txn("rev1", "salary", -4000, "posted")  # clawback, negative, alone
    sent, _, _ = _run(alerts, monkeypatch, budgets={"salary": {"target": Decimal("5000")}},
                      before=[], normalised=[new],
                      cats=[{"id": "salary", "name": "Salary", "bucket": "Income"}])
    assert sent == []


def test_savings_target_never_fires_a_spend_alert(alerts, monkeypatch):
    # WHIT-201: a Savings-bucket target is a floor (an account-balance goal), not a spend
    # ceiling. A discretionary spend mis-filed into a Savings category flows through
    # summarise_transactions as +85 spend and would cross 0.8*100 if Savings weren't
    # excluded from the crossing check. The bucket exclusion keeps it silent — revert it
    # (drop "Savings" from the filter) and this fires.
    new = _txn("s1", "nest_egg", -85, "posted")  # spend mis-filed to a savings category
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"nest_egg": {"target": Decimal("100")}},
                           before=[], normalised=[new],
                           cats=[{"id": "nest_egg", "name": "Nest Egg", "bucket": "Savings"}])
    assert sent == []
    assert notify.fired_markers("2026-07-01", 14) == set()


def test_orphan_spend_target_no_longer_fires(alerts, monkeypatch):
    # WHIT-168 incidental behaviour (locked deliberately): a target whose SPEND category
    # was deleted also stops alerting — a deleted category shouldn't push, and its name
    # would only render as a raw id. groceries budget crosses 80% on spend, but groceries
    # is absent from the live taxonomy (only a different category exists), so no push.
    new = _txn("g1", "groceries", -85, "posted")  # would cross 0.8*100 if not orphaned
    sent, notify, _ = _run(
        alerts, monkeypatch, budgets={"groceries": {"target": Decimal("100")}},
        before=[], normalised=[new],
        cats=[{"id": "coffee", "name": "Coffee", "bucket": "Lifestyle"}],  # groceries NOT here
    )
    assert sent == []
    assert notify.fired_markers("2026-07-01", 14) == set()


def test_orphan_dropped_but_live_target_in_same_batch_still_fires(alerts, monkeypatch):
    # WHIT-168 (qa gap, not covered by the orphan-ALONE tests): the live-category
    # membership filter must drop ONLY the orphan, never a co-batched live target.
    # salary is an ORPHAN income target (id absent from live cats); its -4000 clawback
    # would read as +4000 spend and cross 0.8*5000 on the pre-WHIT-168 code. groceries is
    # a LIVE spend target crossing 80% in the SAME write. Correct: exactly ONE push
    # (groceries), only the groceries#80 marker. On a revert (`set(targets) - income_ids`)
    # the orphan stays in target_ids and ALSO fires -> 2 pushes + a salary#80 marker.
    orphan_clawback = _txn("rev1", "salary", -4000, "posted")   # deleted income cat -> orphan
    live_spend = _txn("g1", "groceries", -85, "posted")         # crosses 0.8*100
    sent, notify, _ = _run(
        alerts, monkeypatch,
        budgets={"salary": {"target": Decimal("5000")}, "groceries": {"target": Decimal("100")}},
        before=[], normalised=[orphan_clawback, live_spend],
        cats=[{"id": "groceries", "name": "Groceries", "bucket": "Living"}],  # salary NOT here
    )
    assert len(sent) == 1
    assert sent[0][1] == "Groceries is at 80% of its budget this cycle."
    assert notify.fired_markers("2026-07-01", 14) == {"groceries#80"}  # no salary marker


def test_debounce_blocks_a_second_event_same_threshold(alerts, monkeypatch):
    notify = notify_repo()
    notify.mark_fired("2026-07-01", 14, "groceries#80")  # already fired this cycle
    before = [_txn("old", "groceries", -70, "posted")]
    new = _txn("new1", "groceries", -15, "posted")
    sent, _, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("100")}},
                      before=before, normalised=[new], notify=notify)
    assert sent == []


def test_new_cycle_rearms_the_alert(alerts, monkeypatch):
    notify = notify_repo()
    notify.mark_fired("2026-07-01", 14, "groceries#80")  # fired in a PRIOR cycle
    before = [_txn("old", "groceries", -70, "posted")]
    new = _txn("new1", "groceries", -15, "posted")
    # This event is in a different cycle (last_pay_date 2026-07-03, still covering the
    # 07-10 txns) → a different marker pk → re-arms and fires again.
    sent, _, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("100")}},
                      before=before, normalised=[new], notify=notify, paycycle=("2026-07-03", 14))
    assert len(sent) == 1


def test_double_crossing_sends_only_100_but_marks_both(alerts, monkeypatch):
    # $0 → -$100 crosses 80% and 100% at once: one push (the 100%), both marked.
    new = _txn("new1", "groceries", -100, "posted")
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("100")}},
                           before=[], normalised=[new])
    assert len(sent) == 1
    assert sent[0][0] == "Budget hit"
    assert notify.fired_markers("2026-07-01", 14) == {"groceries#80", "groceries#100"}


# --- WHIT-154 mark-on-landing: a failed send must NOT mark fired ------------


def test_double_crossing_send_failure_marks_neither_threshold(alerts, monkeypatch):
    # The secondary-loop guard: $0 → -$100 crosses 80% AND 100% at once, but the
    # (100%) send fails. Neither marker may be written — marking 80% while the 100%
    # push never landed would silence the user entirely. Fail-on-revert: the old
    # unconditional code marks both, leaving {"groceries#80", "groceries#100"}.
    new = _txn("new1", "groceries", -100, "posted")
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("100")}},
                           before=[], normalised=[new], send_ok=0)
    assert len(sent) == 1                                          # the 100% send attempted
    assert notify.fired_markers("2026-07-01", 14) == set()        # neither marker written


def test_budget_send_failure_retries_at_the_next_delivery(alerts, monkeypatch):
    # WHIT-577: a failed send releases its claim, and the next delivery re-checks the LEVEL,
    # so the alert is retried even once the GSI has caught up with the first write.
    # Fail-on-revert: drop release_fired (or go back to firing only on a crossing) → no retry.
    budgets = {"groceries": {"target": Decimal("100")}}
    new = _txn("new1", "groceries", -15, "posted")

    # Delivery 1: Expo down. $70 → $85 reaches 80% → attempted, claim released.
    notify = notify_repo()
    before_lagging = [_txn("old", "groceries", -70, "posted")]
    sent1, notify, _ = _run(alerts, monkeypatch, budgets=budgets,
                            before=before_lagging, normalised=[new], notify=notify, send_ok=0)
    assert len(sent1) == 1 and notify.fired_markers("2026-07-01", 14) == set()
    assert released_markers(notify) == ["groceries#80"]

    # Delivery 2: the GSI has caught up ($85 already stored). Still at 80%, still unmarked → retried.
    before_caught_up = [_txn("old", "groceries", -70, "posted"), _txn("new1", "groceries", -15, "posted")]
    sent2, notify, _ = _run(alerts, monkeypatch, budgets=budgets,
                            before=before_caught_up, normalised=[new], notify=notify, send_ok=1)
    assert [title for title, _, _ in sent2] == ["Heads up \U0001f440"]
    assert notify.fired_markers("2026-07-01", 14) == {"groceries#80"}


# --- WHIT-154 gaps (qa): multi-category partial failure + marker interactions ----


def test_two_categories_in_one_write_get_one_combined_push(alerts, monkeypatch):
    budgets = {"groceries": {"target": Decimal("100")}, "coffee": {"target": Decimal("50")}}
    before = [_txn("g", "groceries", -70, "posted"), _txn("c", "coffee", -35, "posted")]
    batch = [_txn("g2", "groceries", -15, "posted"), _txn("c2", "coffee", -10, "posted")]
    cats = [{"id": "groceries", "name": "Groceries"}, {"id": "coffee", "name": "Coffee"}]
    sent, notify, _ = _run(alerts, monkeypatch, budgets=budgets, before=before, normalised=batch, cats=cats)
    assert sent == [("2 budgets need a look",
                     "Coffee, Groceries are at 80% or more of their budget this cycle.",
                     ["ExpoPushToken[a]"])]
    assert notify.fired_markers("2026-07-01", 14) == {"groceries#80", "coffee#80"}


# --- the webhook straddle is best-effort: an alert failure never breaks the write --


class _WriteRecordingRepo:
    def save_failed_transactions(self, rows):
        pass

    def insert_or_reconcile(self, txns, *, is_unfiled=None):
        self.wrote = True


def _raise(*a, **k):
    raise RuntimeError("boom")


@pytest.mark.parametrize("failing_step", ["capture_pre_write", "fire_budget_alerts"])
def test_an_alert_failure_does_not_break_the_write(lam, monkeypatch, failing_step):
    monkeypatch.setattr(lam.budget_alerts, "capture_pre_write", lambda *a, **k: {"stub": True})
    monkeypatch.setattr(lam.budget_alerts, failing_step, _raise)
    repo = _WriteRecordingRepo()
    lam.handler.process_transaction({"id": "e1", "data": []}, repo)  # must not raise
    assert repo.wrote is True


# ===========================================================================
# QA gap tests (WHIT-22) — the reconcile-fidelity of _simulate_after against
# the REAL webhook TransactionRepository, plus boundary / window / refund /
# pagination gaps. The implementer's tests have no pending pool (the reconcile path is
# never exercised); these seed a real pending twin into a FakeTable so
# the reconcile planner runs for real inside the Δ sim.
# Every assertion fails on a revert of the production behaviour it names.
# ===========================================================================

_BANK_ACCT = "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0"  # -> "anz-rewards-black-visa"


def _bank(txn_id, amount, *, pending, category, date="2026-07-10",
          authorized_date="2026-07-10", pending_transaction_id=None,
          merchant_name="SQ *KKV INTERNATIONAL PTY",
          description="SQ *KKV INTERNATIONAL PTY"):
    return {
        "id": txn_id, "date": date, "authorizedDate": authorized_date,
        "description": description, "merchantName": merchant_name,
        "amount": amount, "accountId": _BANK_ACCT, "accountName": "ANZ Rewards Black Visa",
        "category": category, "pending": pending, "type": "PAYMENT",
        "pendingTransactionId": pending_transaction_id,
    }


def _norm_real(alerts, **kw):
    return alerts.banksync.normalise(_bank(**kw))


def _seed(repo, alerts, **kw):
    txn = _norm_real(alerts, **kw)
    repo.insert_transactions([txn])
    return txn


# --- _simulate_after reconcile fidelity (the core untested path) -------------


def test_settlement_delta_is_posted_minus_twin_not_plus_posted(alerts, repo, monkeypatch):
    # Exact-amount settlement (reconcile tier 2). Pending twin -70 groceries sits in
    # BOTH the pre-write window rows and the pending pool; the posted -70 settles it.
    # Correct Δ: twin removed + posted added → combined stays 70 (< 80). A naive
    # `before + posted` would double-count to 140 and fire a FALSE 80% AND 100%.
    _seed(repo, alerts, txn_id="A", amount=Decimal("-70"), pending=True, category="groceries")
    before = list(repo._table.store.values())
    posted = _norm_real(alerts, txn_id="B", amount=Decimal("-70"), pending=False, category="GROCERIES")
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("100")}},
                           before=before, normalised=[posted], webhook_repo=repo)
    assert sent == []
    assert notify.fired_markers("2026-07-01", 14) == set()


def test_tip_adjusted_settlement_crosses_at_true_combined_and_carries_category(alerts, repo, monkeypatch):
    # Tip-adjusted settlement (reconcile tier 3): pending -70 groceries, posted -80
    # (within 70*1.25=87.5), raw uppercase "GROCERIES" category. Correct Δ: twin
    # removed (70) + posted counted-as-carried-groceries (80) → 80, which crosses 80%
    # exactly (70 < 80 <= 80). Fires the 80 push. This single assertion falsifies THREE
    # ways: no carry -> posted stays "GROCERIES" (uncounted) -> 0 -> silent; naive add
    # -> 150 -> would send the 100 copy; a broken tip match -> twin survives -> 150 too.
    _seed(repo, alerts, txn_id="A", amount=Decimal("-70"), pending=True, category="groceries")
    before = list(repo._table.store.values())
    posted = _norm_real(alerts, txn_id="B", amount=Decimal("-80"), pending=False, category="GROCERIES")
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("100")}},
                           before=before, normalised=[posted], webhook_repo=repo)
    assert len(sent) == 1
    assert sent[0][0] == "Heads up \U0001f440"  # the 80 copy, NOT the 100 copy
    assert notify.fired_markers("2026-07-01", 14) == {"groceries#80"}


def test_posted_resync_replaces_not_adds_and_keeps_carried_category(alerts, repo, monkeypatch):
    # Re-sync of an already-stored POSTED row (no pending twin, existing-row carry
    # path). Existing posted -70 groceries; a corrected re-sync of the SAME id arrives
    # -85 raw "GROCERIES". Correct Δ: replace by id (not add) + carry the stored
    # "groceries" → 85 → crosses 80. Fires exactly the 80 push. A double-count would be
    # 155 (100 copy); a dropped carry would be 0 (silent).
    _seed(repo, alerts, txn_id="B", amount=Decimal("-70"), pending=False, category="groceries")
    before = list(repo._table.store.values())
    resync = _norm_real(alerts, txn_id="B", amount=Decimal("-85"), pending=False, category="GROCERIES")
    sent, _, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("100")}},
                      before=before, normalised=[resync], webhook_repo=repo)
    assert len(sent) == 1
    assert sent[0][0] == "Heads up \U0001f440"


def test_alert_fires_reading_window_and_pending_twins_from_the_webhook_store(alerts, repo, monkeypatch):
    # The webhook's own store is the only one passed. A posted -60 settles the -60 twin →
    # spend 80 → exactly the 80% push. Window not read through the store → 60 → no push;
    # pending pool not read through it → 140 → "Budget hit" instead.
    _seed(repo, alerts, txn_id="old", amount=Decimal("-20"), pending=False, category="groceries")
    _seed(repo, alerts, txn_id="A", amount=Decimal("-60"), pending=True, category="groceries")
    settled = [_norm_real(alerts, txn_id="B", amount=Decimal("-60"), pending=False,
                          category="GROCERIES", pending_transaction_id="A")]
    ba = alerts.budget_alerts
    sent = []
    monkeypatch.setattr(ba, "send_push", lambda title, body, tokens, data=None:
                        sent.append((title, body)) or {"sent": 1, "ok": 1, "pruned": []})
    notify = notify_repo()

    ctx = ba.capture_pre_write(
        settled, device_repo=FakeDeviceRepo(),
        budget_repo=FakeBudgetRepo({"groceries": {"target": Decimal("100")}}),
        paycycle_repo=FakePaycycleRepo(), webhook_repo=repo,
    )
    ba.fire_budget_alerts(ctx, settled, category_repo=_FakeCategoryRepo([{"id": "groceries", "name": "Groceries"}]),
                          notify_repo=notify)

    assert sent == [("Heads up \U0001f440", "Groceries is at 80% of its budget this cycle.")]
    assert notify.fired_markers("2026-07-01", 14) == {"groceries#80"}


# --- window filter on the simulated after-rows -------------------------------


def test_txn_dated_outside_cycle_window_does_not_inflate_after(alerts, monkeypatch):
    # A just-written posted row dated AFTER the cycle end (2026-08-01 > 2026-07-14)
    # must be filtered out of the simulated after-set, so it can't push a category
    # across a threshold. Would-be $100 -> excluded -> $0 -> silent.
    new = _txn("future", "groceries", -100, "posted", date="2026-08-01")
    sent, _, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("100")}},
                      before=[], normalised=[new])
    assert sent == []


def test_txn_dated_on_cycle_end_boundary_is_included(alerts, monkeypatch):
    # The inclusive end bound: a row dated exactly on `end` (today, 2026-07-14) counts.
    new = _txn("edge", "groceries", -85, "posted", date="2026-07-14")
    sent, _, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("100")}},
                      before=[], normalised=[new])
    assert len(sent) == 1


# --- threshold boundary (the `<=` inclusive edge) ----------------------------


@pytest.mark.parametrize("new_amount, pushes", [
    (-1, 1),         # $79 -> $80 == 0.8*100: exactly-at fires (`before < T <= after`)
    ("-0.99", 0),    # $79 -> $79.99: one cent under stays silent
])
def test_crossing_is_inclusive_at_exactly_the_threshold(alerts, monkeypatch, new_amount, pushes):
    before = [_txn("old", "groceries", -79, "posted")]
    new = _txn("new1", "groceries", new_amount, "posted")
    sent, _, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("100")}},
                      before=before, normalised=[new])
    assert len(sent) == pushes


# --- target <= 0 guard -------------------------------------------------------


def test_zero_target_budget_never_fires(alerts, monkeypatch):
    # A non-positive target is already unfireable (b >= 0 clamp + the `b <` left bound
    # mean `b < frac*target <= 0` never holds); the explicit target<=0 skip is
    # belt-and-suspenders. $100 spend, $0 target -> silent either way.
    new = _txn("new1", "groceries", -100, "posted")
    sent, _, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("0")}},
                      before=[], normalised=[new])
    assert sent == []


# --- windowed read: cursor pagination ----------------------------------------


def test_window_read_accumulates_every_cursor_page(alerts, monkeypatch):
    ba = alerts.budget_alerts
    sent = []
    monkeypatch.setattr(ba, "send_push",
                        lambda t, b, toks, data=None: (sent.append((t, b)), {"sent": len(list(toks)), "ok": len(list(toks)), "pruned": []})[1])
    # Two pre-write rows ($35 + $35 = $70) split across two pages; the new $15 pushes
    # the total to $85 -> crosses 80. If page 2 were dropped, before=$35 -> after=$50 ->
    # no crossing. So a passing send proves both pages were read.
    rows = [_txn("r0", "groceries", -35, "posted"), _txn("r1", "groceries", -35, "posted")]
    new = _txn("new1", "groceries", -15, "posted")
    store = _AccountPagesTransactionRepo({_ACCT: [([rows[0]], "c1"), ([rows[1]], None)]})
    ctx = ba.capture_pre_write(
        [new], device_repo=FakeDeviceRepo(),
        budget_repo=FakeBudgetRepo({"groceries": {"target": Decimal("100")}}),
        paycycle_repo=FakePaycycleRepo(), webhook_repo=store,
    )
    assert len(ctx["before_rows"]) == 2  # both pages accumulated
    ba.fire_budget_alerts(ctx, [new], category_repo=_FakeCategoryRepo([{"id": "groceries", "name": "Groceries"}]),
                       notify_repo=notify_repo())
    assert len(sent) == 1


# --- per-cycle marker re-arm: the debounce marker must key on the CURRENT cycle start,
# not the raw stored payday, or a stale saved payday freezes the marker bucket and a
# threshold stays suppressed for the whole 60-day TTL instead of re-arming each cycle.


def test_marker_keys_on_current_cycle_start_not_stale_payday(alerts, monkeypatch):
    # Saved payday 2026-06-04 rolls forward (today pinned 2026-07-14) to cycle start
    # 2026-07-02. The marker must be written under the cycle START, not the stale payday.
    before = [_txn("old", "groceries", -70, "posted")]
    new = _txn("new1", "groceries", -15, "posted")   # 70 -> 85, crosses 80% of 100
    sent, notify, ctx = _run(alerts, monkeypatch,
                             budgets={"groceries": {"target": Decimal("100")}},
                             before=before, normalised=[new], paycycle=("2026-06-04", 14))
    assert len(sent) == 1
    assert ctx["start"] == "2026-07-02"                            # rolled forward from stale payday
    assert notify.fired_markers("2026-07-02", 14) == {"groceries#80"}  # keyed on the cycle start
    assert notify.fired_markers("2026-06-04", 14) == set()            # NOT the stale payday


def test_stale_prior_cycle_marker_does_not_suppress_this_cycle(alerts, monkeypatch):
    # Fail-on-revert for the bug Jasmine hit: a marker left under the stale payday key from
    # an earlier cycle must NOT suppress the same crossing in the current cycle. The old
    # code keyed on the raw payday, so it read that stale marker and stayed silent.
    before = [_txn("old", "groceries", -70, "posted")]
    new = _txn("new1", "groceries", -15, "posted")
    notify = notify_repo()
    notify.mark_fired("2026-06-04", 14, "groceries#80")   # stale marker under the raw payday
    sent, notify, ctx = _run(alerts, monkeypatch,
                             budgets={"groceries": {"target": Decimal("100")}},
                             before=before, normalised=[new], paycycle=("2026-06-04", 14), notify=notify)
    assert len(sent) == 1                                          # fires — NOT suppressed by the stale marker
    assert notify.fired_markers("2026-07-02", 14) == {"groceries#80"}


# --- sub-categories: parent rollup alerts (WHIT-222) -------------------------
# A budgeted PARENT holds no transactions of its own — they land on its leaves — so
# its alert fires on the sum over its descendant leaves, mirroring the /budgets read
# rollup. A leaf/orphan target maps to itself, so leaf-only budgets are unchanged.

# Reusable trees: same-bucket (Living) per the WHIT-217 rule.
_CAR_TREE = [
    {"id": "car", "name": "Car", "bucket": "Living", "parent": None},
    {"id": "fuel", "name": "Fuel", "bucket": "Living", "parent": "car"},
    {"id": "parking", "name": "Parking", "bucket": "Living", "parent": "car"},
]


def test_parent_rollup_unbudgeted_leaf_fires(alerts, monkeypatch):
    # THE core fix + fail-on-revert: only the PARENT is budgeted; the spend lands on an
    # unbudgeted leaf (fuel). Rolled up, Car crosses 80% and fires. Reverting to the
    # per-leaf sum makes Car $0 → silent.
    before = [_txn("old", "fuel", -70, "posted")]                 # 70% of Car's 100
    new = _txn("new1", "fuel", -15, "posted")                     # -> 85% rolled up
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"car": {"target": Decimal("100")}},
                           before=before, normalised=[new], cats=_CAR_TREE)
    assert len(sent) == 1
    assert sent[0][0] == "Heads up \U0001f440"
    assert sent[0][1] == "Car is at 80% of its budget this cycle."
    assert notify.fired_markers("2026-07-01", 14) == {"car#80"}


def test_sub_crosses_but_parent_not_only_sub_fires(alerts, monkeypatch):
    # Jasmine's rule: if the SUB creeps past its own limit but the parent's TOTAL hasn't,
    # alert only the sub. Fuel budget 50, Car budget 200. Fuel $45 crosses 80% of 50;
    # Car $45 is only 22.5% of 200 → Car stays silent.
    before = [_txn("old", "fuel", -35, "posted")]
    new = _txn("new1", "fuel", -10, "posted")                     # fuel 45 = 90% of 50
    sent, notify, _ = _run(alerts, monkeypatch,
                           budgets={"car": {"target": Decimal("200")}, "fuel": {"target": Decimal("50")}},
                           before=before, normalised=[new], cats=_CAR_TREE)
    assert len(sent) == 1
    assert sent[0][1] == "Fuel is at 80% of its budget this cycle."
    assert notify.fired_markers("2026-07-01", 14) == {"fuel#80"}   # Car NOT fired


# --- refund / per-leaf >=0 clamp interacting with the parent fold ------------


def test_parent_fold_aggregates_then_clamps_refund_offsets_sibling(alerts, monkeypatch):
    # WHIT-343 (aggregate-then-clamp): a refund OVERSHOOT on one leaf now NETS against a
    # sibling's spend across the subtree BEFORE the floor, matching the /budgets screen so an
    # alert can't fire on a number the screen doesn't show. fuel: -50 then +100 refund -> net
    # -50 (unclamped). parking: -75 -> 75. car before = -50 + 75 = 25. new parking -10 ->
    # parking 85, car after = -50 + 85 = 35 (< 80) -> SILENT. Fail-on-revert (per-leaf clamp
    # restored): fuel floors to 0 -> car after = 85 -> FIRES at 80%.
    before = [
        _txn("f1", "fuel", -50, "posted"),
        _txn("f2", "fuel", 100, "posted"),     # refund overshoot on fuel -> net negative
        _txn("p1", "parking", -75, "posted"),
    ]
    new = _txn("p2", "parking", -10, "posted")             # parking 85; car nets to 35
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"car": {"target": Decimal("100")}},
                           before=before, normalised=[new], cats=_CAR_TREE)
    assert sent == []                                      # the refund nets the crossing away
    assert notify.fired_markers("2026-07-01", 14) == set()


# --- a budgeted mid-node AND its budgeted parent, one shared grandchild ------


def test_mid_node_and_parent_both_fire_off_one_shared_grandchild(alerts, monkeypatch):
    # car -> daily -> petrol (leaf); BOTH car and daily are budgeted at 100. A single
    # petrol write crosses 80% of both rollups -> one combined push, two markers (each a real
    # fact). Reverting the rollup makes both non-leaf parents read $0 -> zero pushes.
    cats = [
        {"id": "car", "name": "Car", "bucket": "Living", "parent": None},
        {"id": "daily", "name": "Daily", "bucket": "Living", "parent": "car"},
        {"id": "petrol", "name": "Petrol", "bucket": "Living", "parent": "daily"},
    ]
    before = [_txn("old", "petrol", -70, "posted")]
    new = _txn("new1", "petrol", -15, "posted")                  # petrol 85 -> both 85
    sent, notify, _ = _run(alerts, monkeypatch,
                           budgets={"car": {"target": Decimal("100")}, "daily": {"target": Decimal("100")}},
                           before=before, normalised=[new], cats=cats)
    assert [body for _, body, _ in sent] == ["Car, Daily are at 80% or more of their budget this cycle."]
    assert notify.fired_markers("2026-07-01", 14) == {"car#80", "daily#80"}


# --- parent-DIRECT spend crosses a threshold (WHIT-228) ----------------------
# A write tagged straight onto a budgeted PARENT must count toward its rollup, so it
# can trip the parent's alert — matching the /budgets bar and the /breakdown screen.


def test_parent_direct_spend_crosses_and_fires(alerts, monkeypatch):
    # Car budgeted at 100; 70 already on the leaf `parking`. A NEW write tagged straight
    # onto `car` itself (15) pushes the rollup to 85 -> crosses 80% -> fires. Fail-on-
    # revert: drop the parent id from the subtree and car-direct 15 vanishes, leaving 70
    # -> no crossing -> silent.
    before = [_txn("old", "parking", -70, "posted")]
    new = _txn("new1", "car", -15, "posted")                      # tagged directly onto the parent
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"car": {"target": Decimal("100")}},
                           before=before, normalised=[new], cats=_CAR_TREE)
    assert len(sent) == 1
    assert sent[0][1] == "Car is at 80% of its budget this cycle."
    assert notify.fired_markers("2026-07-01", 14) == {"car#80"}


def test_mid_level_direct_spend_crosses_parent_and_fires(alerts, monkeypatch):
    # car -> daily -> petrol; only car budgeted. A write tagged straight onto the
    # INTERMEDIATE `daily` (not the root, not a leaf) must roll into car. Fail-on-revert:
    # a leaves-only walk drops mid-node spend, so car reads 70 -> silent.
    cats = [
        {"id": "car", "name": "Car", "bucket": "Living", "parent": None},
        {"id": "daily", "name": "Daily", "bucket": "Living", "parent": "car"},
        {"id": "petrol", "name": "Petrol", "bucket": "Living", "parent": "daily"},
    ]
    before = [_txn("old", "petrol", -70, "posted")]
    new = _txn("new1", "daily", -15, "posted")                    # tagged directly onto the mid node
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"car": {"target": Decimal("100")}},
                           before=before, normalised=[new], cats=cats)
    assert len(sent) == 1
    assert sent[0][1] == "Car is at 80% of its budget this cycle."
    assert notify.fired_markers("2026-07-01", 14) == {"car#80"}


def test_cross_bucket_child_never_crosses_parent_threshold(alerts, monkeypatch):
    # WHIT-229: a Lifestyle child corruptly parented under a Living budgeted parent must NOT
    # push it across a threshold — the same-bucket guard drops it from Car's subtree, so Car
    # sees none of its spend. The write alone would be 100% of Car if folded. Fail-on-revert
    # (drop bucket_by_id): the unguarded walk folds it in and fires a false push.
    cats = [
        {"id": "car", "name": "Car", "bucket": "Living", "parent": None},
        {"id": "misfiled", "name": "Misfiled", "bucket": "Lifestyle", "parent": "car"},
    ]
    new = _txn("new1", "misfiled", -100, "posted")                # would be 100% of Car if folded
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"car": {"target": Decimal("100")}},
                           before=[], normalised=[new], cats=cats)
    assert sent == []
    assert notify.fired_markers("2026-07-01", 14) == set()


def test_skewed_date_settlement_counts_the_purchase_once(alerts, repo, monkeypatch):
    # WHIT-331: the real false-alert scenario. ANZ dated the pending 07-11 (Melbourne)
    # and its settled twin 07-10 (UTC), so the equal-date tiers miss and BOTH rows count.
    # Correct Δ: the skewed tier removes the twin -> combined stays 70 (< 80) -> silent.
    # Without the tier the pending survives -> 140 -> a FALSE 80% AND 100% push, which is
    # exactly what fired on the live coffee budget.
    _seed(repo, alerts, txn_id="A", amount=Decimal("-70"), pending=True, category="groceries",
          date="2026-07-11", authorized_date="2026-07-11", merchant_name="",
          description="POS AUTHORISATION         SQ *KKV INTERNATIONAL PTYSunshine     AU")
    before = list(repo._table.store.values())
    # NOTE the posted carries the budgeted id itself: with a raw "GROCERIES" the unmerged
    # row wouldn't count toward the budget at all, and the test would pass either way.
    posted = _norm_real(alerts, txn_id="B", amount=Decimal("-70"), pending=False,
                        category="groceries", date="2026-07-14", authorized_date="2026-07-10",
                        description="SQ *KKV INTERNATIONAL PTY Sunshine",
                        merchant_name="SQ *KKV INTERNATIONAL PTY ")

    sent, notify, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("100")}},
                           before=before, normalised=[posted], webhook_repo=repo)

    assert sent == []
    assert notify.fired_markers("2026-07-01", 14) == set()


# --- WHIT-331 QA gap: the false push must stay silent for the WHOLE feed window ---


def test_simulation_matches_the_real_write_when_a_posting_precedes_its_pending_resend(alerts, repo):
    # WHIT-331: the alert preview replays the batch in payload order, but the real write
    # inserts everything and deletes the stale pendings AFTERWARDS. With the settlement
    # listed before its pending's re-send, popping the twin inline let the re-send re-add
    # itself — the preview counted the charge twice and fired the very "you've spent your
    # whole budget" push this card exists to stop, while the ledger held one row.
    _seed(repo, alerts, txn_id="PEND", amount=Decimal("-70"), pending=True, category="groceries",
          date="2026-07-11", authorized_date="2026-07-11", merchant_name="",
          description="POS AUTHORISATION         SQ *KKV INTERNATIONAL PTYSunshine     AU")
    before = list(repo._table.store.values())
    account = before[0]["account_id"]
    resend = _norm_real(alerts, txn_id="PEND", amount=Decimal("-70"), pending=True,
                        category="FOOD_AND_DRINK", date="2026-07-11", authorized_date="2026-07-11",
                        merchant_name="",
                        description="POS AUTHORISATION         SQ *KKV INTERNATIONAL PTYSunshine     AU")
    posted = _norm_real(alerts, txn_id="POST", amount=Decimal("-70"), pending=False,
                        category="groceries", date="2026-07-14", authorized_date="2026-07-10",
                        description="SQ *KKV INTERNATIONAL PTY Sunshine",
                        merchant_name="SQ *KKV INTERNATIONAL PTY ")
    ctx = {"before_rows": before,
           "pending_pools": {account: list(repo.get_account_transactions(account, "pending"))},
           "start": "2026-07-01", "end": "2026-07-14"}

    simulated = alerts.budget_alerts._simulate_after(ctx, [posted, resend])  # posted FIRST
    repo.insert_or_reconcile([posted, resend])

    stored = list(repo._table.store.values())
    assert sorted(r["transaction_id"] for r in simulated) == sorted(r["transaction_id"] for r in stored)
    assert [r["transaction_id"] for r in stored] == ["POST"]


# ======================================================================================
# Folded from per-ticket budget-alert satellites (WHIT-452 Slice 1). Bodies moved
# verbatim; budget_296's copy of the fake repos / alerts fixture was dropped
# in favour of this file's harness above.
# ======================================================================================


# --- WHIT-296: the over-budget push honours the budget_excluded override --------------
# (was test_budget_alerts_whit296.py) Reuses this file's fake repos above.
# [A-P1] drives the REAL webhook repo through the carry + spend gate; [A-P2] the gate alone.


def _posted(txn_id, category, amount, budget_excluded=None, date="2026-07-10"):
    row = {
        "transaction_id": txn_id, "account_id": _ACCT, "category": category,
        "amount": Decimal(str(amount)), "status": "posted", "date": date,
        "counts_to_budget": True, "authorized_date": date,
    }
    if budget_excluded is not None:
        row["budget_excluded"] = budget_excluded
    return row


def test_excluded_settling_twin_does_not_fire_over_budget_alert(alerts, repo, monkeypatch):
    # [A-P1] The pending groceries -85 (85% of a 100 budget) was marked "exclude". On
    # settlement the posted twin carries the override, so the Δ sees $0 of groceries
    # spend and no threshold is crossed. Uses the REAL webhook repo for the carry.
    # Fail-on-revert: revert the carry OR the spend gate and after jumps to $85 -> the
    # 80% push fires and this goes red.
    acc = "ACCOUNT#" + _ACCT
    repo._table.store[(acc, "TXN#pend1")] = {
        "pk": acc, "sk": "TXN#pend1", "transaction_id": "pend1", "account_id": _ACCT,
        "category": "groceries", "amount": Decimal("-85"), "status": "pending",
        "date": "2026-07-10", "authorized_date": "2026-07-10",
        "counts_to_budget": True, "budget_excluded": True,
    }
    before = [dict(repo._table.store[(acc, "TXN#pend1")])]  # window read sees the pending
    posted = _posted("post1", "groceries", -85)             # bank feed: no override

    sent, notify, _ = _run(alerts, monkeypatch,
                           budgets={"groceries": {"target": Decimal("100")}},
                           before=before, normalised=[posted], webhook_repo=repo)

    assert sent == []
    assert notify.fired_markers("2026-07-01", 14) == set()


# ── WHIT-509: the alert threshold folds in the bill-spread cushion ──────────────
#
# The /budgets screen spends against target + the signed spread adjustment (WHIT-504):
# a full +amount cushion in the cycle the bill lands, an equal slice taken back over the
# next N cycles. Before this fix the push path crossed against the RAW target only, so a
# cushioned category that the screen shows as in-budget could still fire a false "over
# budget" push. fire_budget_alerts now crosses against the row's `available` from
# budget_standing.py — the same number /budgets shows. The maths itself is pinned in
# tests/shared/test_budget_standing.py; these check the alert is wired to it.
#
# Cushion note: with the pinned cycle (start 2026-07-01, len 14, today 2026-07-14) an
# ALIGNED spread carries spread_from=2026-07-01, spread_len=14, spread_paydate=2026-07-01
# → index 0 → the +amount cushion. spread_from one cycle back (2026-06-17) → index 1 → a
# payback slice (negative). A mismatched len/paydate is MISALIGNED → settled like the read
# path. Spread-alert cats carry a real spend bucket ("Living") so they exercise the live
# spend-category path, not a bucket-less shortcut.

_SPREAD_CATS = [{"id": "groceries", "name": "Groceries", "bucket": "Living"}]


def _spread_fields(amount, cycles, *, spread_from="2026-07-01", spread_len=14,
                   spread_paydate="2026-07-01"):
    """The five stored bill-spread fields, Decimal-typed like a real write."""
    return {
        "spread_amount": Decimal(str(amount)), "spread_cycles": Decimal(cycles),
        "spread_from": spread_from, "spread_len": Decimal(spread_len),
        "spread_paydate": spread_paydate,
    }


def test_spread_cushion_suppresses_a_false_over_budget_push(alerts, monkeypatch):
    # (a) Anchor cycle: a $200 bill spread over 4 cycles cushions a $100 target to a $300
    # basis. $70 → $120 of spend stays under 80% of the basis ($240), so NO push. Revert
    # the basis to the raw target and $120 crosses 100% of $100 → a false "over budget"
    # push appears. THE bug this card fixes.
    budget = {"target": Decimal("100"), **_spread_fields(200, 4)}
    before = [_txn("old", "groceries", -70, "posted")]
    new = _txn("new1", "groceries", -50, "posted")
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"groceries": budget},
                           before=before, normalised=[new], cats=_SPREAD_CATS)
    assert sent == []
    assert notify.fired_markers("2026-07-01", 14) == set()


def test_spread_basis_exactly_zero_is_skipped(alerts, monkeypatch):
    # [A-qa9] (P0) A payback slice equal to the whole target drives basis to EXACTLY $0
    # (target 100, $200 over 2 cycles, index 1 → −$100 slice → basis 0). The `basis <= 0`
    # guard skips it, so even a huge $500 overspend sends NOTHING — a push the user could
    # not act on. Locks the deliberate silence at basis == 0.
    # Fail-on-revert (basis→target): basis becomes the raw $100, $500 crosses both → a
    # "Budget hit" push fires.
    budget = {"target": Decimal("100"), **_spread_fields(200, 2, spread_from="2026-06-17")}
    new = _txn("new1", "groceries", -500, "posted")
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"groceries": budget},
                           before=[], normalised=[new], cats=_SPREAD_CATS)
    assert sent == []
    assert notify.fired_markers("2026-07-01", 14) == set()


# --- WHIT-555: rollover live buffer is folded INTO the alert basis ---------------------
# The /budgets screen's spendable = target + live rollover buffer. The alert must agree:
# `basis = target + buffer`, so a category with leftover from prior cycles has a higher
# crossing threshold (the user sees more room), and one with a deficit has a lower one.


_ROLLOVER = {
    "rollover": True, "carryover": Decimal("0"), "carryover_from": "2026-06-17",
    "carryover_len": Decimal("14"), "carryover_paydate": "2026-07-01",
}


def test_rollover_buffer_folds_live_from_prior_cycle_txns(alerts, monkeypatch):
    # One completed cycle [2026-06-17, 2026-06-30] with $60 spend on a $100 target → leftover $40.
    # Stored carryover = $0, so live buffer = 0 + 40 = $40. basis = 100 + 40 = 140, 80% = $112.
    # Current-cycle spend before $105, +$10 → $115 crosses $112 → fires.
    # Fail-on-revert: without live seal, buffer = 0, basis = 100, 80% = $80, $105 already past → miss.
    budget = {"target": Decimal("100"), **_ROLLOVER}
    prior_txn = _txn("prior1", "groceries", -60, "posted", date="2026-06-20")
    current_before = _txn("old", "groceries", -105, "posted")
    before = [prior_txn, current_before]
    new = _txn("new1", "groceries", -10, "posted")
    sent, _, ctx = _run(alerts, monkeypatch, budgets={"groceries": budget},
                        before=before, normalised=[new], cats=_SPREAD_CATS)
    assert len(sent) == 1
    assert "80%" in sent[0][1]
    # before_rows must be current-cycle only (prior_txn filtered out)
    assert all(r["date"] >= "2026-07-01" for r in ctx["before_rows"])


def test_widened_rollover_read_does_not_leak_last_cycle_into_a_plain_budget(alerts, monkeypatch):
    # A rollover budget widens the read back to 2026-06-17. Dining (plain, $100) spent
    # $500 LAST cycle and only $20 + $10 this one → 30%, no push. If last cycle's rows leak into
    # this cycle's spend, Dining reads $530 → a false "Budget hit".
    cats = _SPREAD_CATS + [{"id": "dining", "name": "Dining", "bucket": "Lifestyle"}]
    budgets = {"groceries": {"target": Decimal("1000"), **_ROLLOVER},
               "dining": {"target": Decimal("100")}}
    before = [_txn("prior", "dining", -500, "posted", date="2026-06-20"),
              _txn("old", "dining", -20, "posted", date="2026-07-05")]
    sent, _, _ = _run(alerts, monkeypatch, budgets=budgets, before=before,
                      normalised=[_txn("new1", "dining", -10, "posted")], cats=cats)
    assert sent == []


def test_this_cycle_rows_are_counted_once_not_twice_with_rollover_history(alerts, monkeypatch):
    # The rollover read's current-cycle rows are also in the after-write rows. They
    # must count once: $70 + $5 = $75 of a $100 + $0 carryover basis → no push. Counted twice
    # ($145) it would read "Budget hit".
    before = [_txn("prior", "groceries", -100, "posted", date="2026-06-20"),
              _txn("old", "groceries", -70, "posted", date="2026-07-05")]
    sent, _, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("100"), **_ROLLOVER}},
                      before=before, normalised=[_txn("new1", "groceries", -5, "posted")], cats=_SPREAD_CATS)
    assert sent == []


def test_rollover_overspend_last_cycle_lowers_the_alert_basis(alerts, monkeypatch):
    # Last cycle overspent by $40 → carryover −$40 → basis $60, 80% = $48. This cycle
    # $40 + $10 = $50 → the 80% push. On the raw $100 target that would be silent.
    before = [_txn("prior", "groceries", -140, "posted", date="2026-06-20"),
              _txn("old", "groceries", -40, "posted", date="2026-07-05")]
    sent, _, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("100"), **_ROLLOVER}},
                      before=before, normalised=[_txn("new1", "groceries", -10, "posted")], cats=_SPREAD_CATS)
    assert len(sent) == 1
    assert "80%" in sent[0][1]


# --- WHIT-545: the crossing preview mirrors the write's settlement carry gate ----------------

def _bal_bank_row(txn_id, amount, *, pending, category, date="2026-07-10"):
    # A raw BankSync row resolving to the anz-rewards-black-visa account (a budget-counting one).
    return {
        "id": txn_id, "date": date, "authorizedDate": date,
        "description": "SQ *KKV INTERNATIONAL PTY", "merchantName": "SQ *KKV INTERNATIONAL PTY",
        "amount": Decimal(str(amount)),
        "accountId": "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0",
        "accountName": "ANZ Rewards Black Visa", "category": category, "pending": pending,
        "type": "PAYMENT", "pendingTransactionId": None,
    }


def test_whit545_preview_buckets_a_settlement_under_the_landed_category(alerts, repo, monkeypatch):
    # A pending twin holds the bank's raw enum (unfiled); the settling posted was rule-filled to
    # "groceries". The preview must bucket the -$15 under groceries (what actually lands), so
    # before $70 + $15 = $85 crosses 80%. FAIL-ON-REVERT: drop the is_unfiled arg on
    # fire_budget_alerts's `_simulate_after(...)` call and the raw enum carries in the preview, so the
    # -$15 buckets under FOOD_AND_DRINK, groceries stays at $70, and no push fires.
    ba = alerts.budget_alerts
    sent = []
    monkeypatch.setattr(ba, "send_push",
                        lambda title, body, toks, data=None: sent.append((title, body)) or
                        {"sent": len(list(toks)), "ok": 1, "pruned": []})

    pending = alerts.banksync.normalise(
        _bal_bank_row("PEND", -15, pending=True, category="FOOD_AND_DRINK"))
    repo.insert_transactions([pending])
    posted = alerts.banksync.normalise(
        _bal_bank_row("POST", -15, pending=False, category="groceries"))

    before = [_txn("old", "groceries", -70, "posted")]
    ctx = ba.capture_pre_write(
        [posted], device_repo=FakeDeviceRepo(), budget_repo=FakeBudgetRepo({"groceries": {"target": Decimal("100")}}),
        paycycle_repo=FakePaycycleRepo(last_pay_date="2026-07-01", length=14),
            webhook_repo=_AccountTransactionRepo(before, pending_repo=repo))
    ba.fire_budget_alerts(
        ctx, [posted], category_repo=_FakeCategoryRepo([{"id": "groceries", "name": "Groceries"}]),
        notify_repo=notify_repo())

    assert len(sent) == 1
    assert sent[0][1] == "Groceries is at 80% of its budget this cycle."


# --- WHIT-577: fire on the LEVEL reached, not only on a delivery's own crossing -------------


def test_hand_filed_overspend_warns_on_an_empty_sync(alerts, monkeypatch):
    # Jas's bug: Groceries was pushed to $110 of $100 by filing in the app (no alert runs
    # there). An empty sync delivery must still send the 100% push and mark both thresholds.
    # Fail-on-revert: fire only on a crossing → an empty delivery crosses nothing → silent.
    before = [_txn("filed-by-hand", "groceries", -110, "posted")]
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("100")}},
                           before=before, normalised=[])
    assert [(title, body) for title, body, _ in sent] == [
        ("Budget hit", "You've spent your whole Groceries budget for this cycle.")]
    assert notify.fired_markers("2026-07-01", 14) == {"groceries#100", "groceries#80"}


def test_budget_over_by_hand_is_warned_alongside_the_arriving_one(alerts, monkeypatch):
    # Health crosses on arrival while Groceries was already over by hand: both are due, so
    # ONE combined push names both (before WHIT-577 only Health would have fired).
    cats = [{"id": "health", "name": "Health"}, {"id": "groceries", "name": "Groceries"}]
    before = [_txn("h0", "health", -70, "posted"), _txn("g0", "groceries", -120, "posted")]
    arriving = _txn("h1", "health", -15, "posted")
    sent, notify, _ = _run(alerts, monkeypatch,
                           budgets={"health": {"target": Decimal("100")}, "groceries": {"target": Decimal("100")}},
                           before=before, normalised=[arriving], cats=cats)
    assert [title for title, _, _ in sent] == ["2 budgets need a look"]
    assert notify.fired_markers("2026-07-01", 14) == {"health#80", "groceries#100", "groceries#80"}


def test_a_claim_lost_to_an_overlapping_delivery_sends_nothing(alerts, monkeypatch):
    # Two feeds sync on the same tick; the other delivery claimed the marker first.
    # Fail-on-revert: send without claiming (read-then-mark) → a second, duplicate push.
    before = [_txn("old", "groceries", -90, "posted")]
    notify = notify_repo()
    notify._table.fail("update_item", error=_client_error("ConditionalCheckFailedException"))
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("100")}},
                           before=before, normalised=[], notify=notify)
    assert sent == []
    assert released_markers(notify) == []


def test_one_budget_already_warned_leaves_a_single_budget_push_with_its_deep_link(alerts, monkeypatch):
    # Coffee was warned earlier; only Groceries is newly due → its own copy + deep link, not a
    # combined push.
    ba = alerts.budget_alerts
    pushed = []
    monkeypatch.setattr(ba, "send_push",
                        lambda title, body, toks, data=None: (pushed.append((title, data)), {"sent": 1, "ok": 1, "pruned": []})[1])
    cats = [{"id": "groceries", "name": "Groceries"}, {"id": "coffee", "name": "Coffee"}]
    budgets = {"groceries": {"target": Decimal("100")}, "coffee": {"target": Decimal("50")}}
    before = [_txn("g", "groceries", -90, "posted"), _txn("c", "coffee", -45, "posted")]
    notify = notify_repo()
    notify.mark_fired("2026-07-01", 14, "coffee#80")
    ctx = ba.capture_pre_write([], device_repo=FakeDeviceRepo(), budget_repo=FakeBudgetRepo(budgets),
                               paycycle_repo=FakePaycycleRepo(), webhook_repo=_AccountTransactionRepo(before))
    ba.fire_budget_alerts(ctx, [], category_repo=_FakeCategoryRepo(cats),
                          notify_repo=notify)
    assert pushed == [("Heads up \U0001f440", {"type": "budget", "category": "groceries"})]


_THREE_OVER = {
    "budgets": {name: {"target": Decimal("100")} for name in ("alpha", "bravo", "coffee")},
    "before": [_txn(f"t-{name}", name, -90, "posted") for name in ("alpha", "bravo", "coffee")],
    "cats": [{"id": name, "name": name.title()} for name in ("alpha", "bravo", "coffee")],
}


def test_a_claim_that_raises_releases_the_earlier_claims(alerts, monkeypatch):
    # The 2nd claim is throttled: nothing is sent and the 1st claim must be released, or that
    # budget stays silent all cycle. Fail-on-revert: drop the except-release → 1st stays claimed.
    import repository_errors
    notify = notify_repo()
    fail_nth_write(notify, "ADD", 2)
    with pytest.raises(repository_errors.DatabaseError):
        _run(alerts, monkeypatch, budgets=_THREE_OVER["budgets"], before=_THREE_OVER["before"],
             normalised=[], cats=_THREE_OVER["cats"], notify=notify)
    assert notify.fired_markers("2026-07-01", 14) == set()
    assert len(released_markers(notify)) == 1


class _ReadTimeoutError(OSError):
    """botocore's ReadTimeoutError is an OSError, not a ClientError, so it is never converted to
    a DatabaseError (the lam fixture stubs botocore, so it is modelled here)."""


@pytest.mark.parametrize("error_name", ["DatabaseError", "ReadTimeoutError"])
def test_one_failed_release_does_not_strand_the_others(alerts, monkeypatch, error_name):
    # A combined push that didn't land: the 1st release is throttled (or times out), the rest
    # still release. Fail-on-revert: a bare loop, or catching only DatabaseError, strands claims.
    # A throttle ClientError reaches budget_alerts as the repository's DatabaseError.
    error = {"DatabaseError": None, "ReadTimeoutError": _ReadTimeoutError("read timed out")}[error_name]
    notify = notify_repo()
    fail_nth_write(notify, "DELETE", 1, error)
    sent, notify, _ = _run(alerts, monkeypatch, budgets=_THREE_OVER["budgets"], before=_THREE_OVER["before"],
                           normalised=[], cats=_THREE_OVER["cats"], notify=notify, send_ok=0)
    assert len(sent) == 1
    assert len(released_markers(notify)) == 3                 # every claim's release was attempted
    assert len(notify.fired_markers("2026-07-01", 14)) == 1   # only the failed release is left behind


# --- WHIT-577 gaps (qa): send failures, partial claim loss, empty deliveries ------------------


def test_no_80_nag_after_100_already_sent(alerts, monkeypatch):
    # groceries#100 landed but its 80 mark was lost; a refund drops spend to $85. An 80%
    # "Heads up" after "Budget hit" would be backwards. Fail-on-revert: check only the exact
    # marker → the 80% push goes out.
    notify = notify_repo()
    notify.mark_fired("2026-07-01", 14, "groceries#100")
    before = [_txn("old", "groceries", -105, "posted")]
    refund = _txn("r1", "groceries", 20, "posted")
    sent, _, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("100")}},
                      before=before, normalised=[refund], notify=notify)
    assert sent == []


def _signature_spy(real, calls, result):
    """Records the arguments only if they bind to `real`'s signature."""
    signature = inspect.signature(real)

    def spy(*args, **kwargs):
        calls.append(signature.bind(*args, **kwargs).arguments)
        return result

    return spy


def test_dataless_delivery_still_runs_the_alert_check(lam, monkeypatch):
    # The fix rests on "the next delivery, even an empty sync" re-checking levels.
    # Fail-on-revert: an early return for an empty payload in process_transaction. Both
    # alert calls sit inside `except Exception`, so the spies also prove each call still
    # fits its function's real signature — a mismatch would switch every alert off silently.
    ba = lam.budget_alerts
    captured, fired = [], []
    monkeypatch.setattr(ba, "capture_pre_write", _signature_spy(ba.capture_pre_write, captured, {"ctx": True}))
    monkeypatch.setattr(ba, "fire_budget_alerts", _signature_spy(ba.fire_budget_alerts, fired, None))
    repo = _WriteRecordingRepo()

    lam.handler.process_transaction({"id": "sync-completed-1"}, repo)

    assert len(captured) == 1 and captured[0]["webhook_repo"] is repo
    assert len(fired) == 1
    assert fired[0]["ctx"] == {"ctx": True} and list(fired[0]["normalised"]) == []
