"""Budget-threshold alert detection (shared/budget_alerts.py), WHIT-22.

Driven through the webhook `lam` fixture (so budget_alerts + the real webhook repo
reconcile primitives are importable). `spend._melbourne_today` is pinned so the
cycle window is deterministic. `send_push` is stubbed to capture pushes.

The load-bearing test is `test_crossing_fires_via_delta_not_a_reread`: the fake
window repo returns ONLY the pre-write rows (it never sees the just-written row),
so a crossing can only be detected by the in-memory Δ — locking that detection is
immune to the date-index GSI's eventual consistency (the bug the design fixes).
"""

from datetime import date
from decimal import Decimal

import pytest

# Cycle: last_pay_date 2026-07-01, length 14, pinned "today" 2026-07-14 →
# window [2026-07-01, 2026-07-14]. All test transactions are dated inside it.
_TODAY = date(2026, 7, 14)
_ACCT = "up-spending"


@pytest.fixture
def alerts(lam, monkeypatch):
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: _TODAY)
    return lam


def _txn(txn_id, category, amount, status, date="2026-07-10"):
    """A normalised-transaction-like dict (models.Transaction is dict-like)."""
    return {
        "transaction_id": txn_id, "account_id": _ACCT, "category": category,
        "amount": Decimal(str(amount)), "status": status, "date": date,
        "counts_to_budget": True, "authorized_date": date,
    }


class FakeWindowRepo:
    """The pre-write windowed read — returns ONLY the seeded before-rows."""

    def __init__(self, rows):
        self._rows = rows

    def get_transactions_by_date_range(self, account_id, start, end, limit=100, cursor=None):
        return ([r for r in self._rows if r["account_id"] == account_id], None)


class FakeBudgetRepo:
    def __init__(self, budgets):
        self._b = budgets

    def list_budgets(self):
        return self._b


class FakePaycycleRepo:
    def __init__(self, last="2026-07-01", length=14):
        self._c = {"last_pay_date": last, "length": length}

    def get_paycycle(self):
        return dict(self._c)


class FakeDeviceRepo:
    def __init__(self, tokens=("ExpoPushToken[a]",)):
        self._t = list(tokens)

    def list_tokens(self):
        return list(self._t)


class FakeCategoryRepo:
    def __init__(self, cats):
        self._c = cats

    def list_categories(self):
        return self._c


class FakeNotifyRepo:
    """Debounce marker keyed by (last_pay_date, length) so cycles are isolated."""

    def __init__(self):
        self.store: dict = {}
        self.order: list = []

    def fired_markers(self, last, length):
        return set(self.store.get((last, length), set()))

    def mark_fired(self, last, length, marker):
        self.store.setdefault((last, length), set()).add(marker)
        self.order.append(marker)


class NoTwinRepo:
    """webhook_repo stand-in: no pending twins, carries no category."""

    def get_pending_transactions_for_account(self, account):
        return []

    def _find_pending_twin(self, txn, pools):
        return None

    @staticmethod
    def _with_carried_category(txn, src):
        return dict(txn)


def _run(alerts, monkeypatch, *, budgets, before, normalised, tokens=("ExpoPushToken[a]",),
         cats=None, webhook_repo=None, notify=None, paycycle=("2026-07-01", 14)):
    ba = alerts.budget_alerts
    sent = []
    monkeypatch.setattr(ba, "send_push", lambda title, body, toks: sent.append((title, body, list(toks))))
    notify = notify or FakeNotifyRepo()
    webhook_repo = webhook_repo or NoTwinRepo()
    ctx = ba.capture_pre_write(
        normalised,
        device_repo=FakeDeviceRepo(tokens),
        budget_repo=FakeBudgetRepo(budgets),
        paycycle_repo=FakePaycycleRepo(*paycycle),
        window_repo=FakeWindowRepo(before),
        webhook_repo=webhook_repo,
    )
    ba.fire_if_crossed(
        ctx, normalised, webhook_repo=webhook_repo,
        category_repo=FakeCategoryRepo(cats or [{"id": "groceries", "name": "Groceries"}]),
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


def test_below_threshold_does_not_fire(alerts, monkeypatch):
    before = [_txn("old", "groceries", -70, "posted")]
    new = _txn("new1", "groceries", -5, "posted")  # after $75 < $80
    sent, _, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("100")}},
                      before=before, normalised=[new])
    assert sent == []


def test_pending_spend_counts_toward_the_threshold(alerts, monkeypatch):
    # A pending authorisation alone pushes spent+pending past 80%.
    new = _txn("p1", "groceries", -85, "pending")
    sent, _, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("100")}},
                      before=[], normalised=[new])
    assert len(sent) == 1


def test_raw_uppercase_enum_category_never_matches_a_budget(alerts, monkeypatch):
    # A freshly-synced row with BankSync's raw "GROCERIES" (not the "groceries" slug)
    # can't match the budget id → no alert (documents the WHIT-22 gate-1 reality check).
    new = _txn("new1", "GROCERIES", -85, "posted")
    sent, _, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("100")}},
                      before=[], normalised=[new])
    assert sent == []


def test_debounce_blocks_a_second_event_same_threshold(alerts, monkeypatch):
    notify = FakeNotifyRepo()
    notify.mark_fired("2026-07-01", 14, "groceries#80")  # already fired this cycle
    before = [_txn("old", "groceries", -70, "posted")]
    new = _txn("new1", "groceries", -15, "posted")
    sent, _, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("100")}},
                      before=before, normalised=[new], notify=notify)
    assert sent == []


def test_new_cycle_rearms_the_alert(alerts, monkeypatch):
    notify = FakeNotifyRepo()
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
    assert sent[0][0] == "Budget hit \U0001fa93"
    assert notify.fired_markers("2026-07-01", 14) == {"groceries#80", "groceries#100"}


def test_send_precedes_mark(alerts, monkeypatch):
    ba = alerts.budget_alerts
    order = []
    monkeypatch.setattr(ba, "send_push", lambda *a: order.append("send"))
    notify = FakeNotifyRepo()
    orig_mark = notify.mark_fired
    notify.mark_fired = lambda *a: (order.append("mark"), orig_mark(*a))[1]
    before = [_txn("old", "groceries", -70, "posted")]
    ctx = ba.capture_pre_write(
        [_txn("new1", "groceries", -15, "posted")],
        device_repo=FakeDeviceRepo(), budget_repo=FakeBudgetRepo({"groceries": {"target": Decimal("100")}}),
        paycycle_repo=FakePaycycleRepo(), window_repo=FakeWindowRepo(before), webhook_repo=NoTwinRepo(),
    )
    ba.fire_if_crossed(ctx, [_txn("new1", "groceries", -15, "posted")], webhook_repo=NoTwinRepo(),
                       category_repo=FakeCategoryRepo([{"id": "groceries", "name": "Groceries"}]), notify_repo=notify)
    assert order[0] == "send" and "mark" in order


def test_two_categories_cross_in_one_write(alerts, monkeypatch):
    budgets = {"groceries": {"target": Decimal("100")}, "coffee": {"target": Decimal("50")}}
    before = [_txn("g", "groceries", -70, "posted"), _txn("c", "coffee", -35, "posted")]
    batch = [_txn("g2", "groceries", -15, "posted"), _txn("c2", "coffee", -10, "posted")]
    cats = [{"id": "groceries", "name": "Groceries"}, {"id": "coffee", "name": "Coffee"}]
    sent, _, _ = _run(alerts, monkeypatch, budgets=budgets, before=before, normalised=batch, cats=cats)
    assert len(sent) == 2
    assert {s[1].split(" is")[0].split("your whole ")[-1].rstrip(".") for s in sent} == {"Groceries", "Coffee"}


def test_no_tokens_skips_everything(alerts, monkeypatch):
    ba = alerts.budget_alerts

    class ExplodingBudgetRepo:
        def list_budgets(self):
            raise AssertionError("must not be read when there are no tokens")

    ctx = ba.capture_pre_write(
        [_txn("new1", "groceries", -100, "posted")],
        device_repo=FakeDeviceRepo(tokens=()), budget_repo=ExplodingBudgetRepo(),
        paycycle_repo=FakePaycycleRepo(), window_repo=FakeWindowRepo([]), webhook_repo=NoTwinRepo(),
    )
    assert ctx is None


def test_no_budgets_skips_the_window_read(alerts, monkeypatch):
    ba = alerts.budget_alerts

    class ExplodingWindowRepo:
        def get_transactions_by_date_range(self, *a, **k):
            raise AssertionError("must not read the window when there are no budgets")

    ctx = ba.capture_pre_write(
        [_txn("new1", "groceries", -100, "posted")],
        device_repo=FakeDeviceRepo(), budget_repo=FakeBudgetRepo({}),
        paycycle_repo=FakePaycycleRepo(), window_repo=ExplodingWindowRepo(), webhook_repo=NoTwinRepo(),
    )
    assert ctx is None


def test_fire_if_crossed_ignores_a_none_context(alerts, monkeypatch):
    ba = alerts.budget_alerts
    monkeypatch.setattr(ba, "send_push", lambda *a: (_ for _ in ()).throw(AssertionError("no send")))
    ba.fire_if_crossed(None, [], webhook_repo=NoTwinRepo(),
                       category_repo=FakeCategoryRepo([]), notify_repo=FakeNotifyRepo())  # no raise


# --- the webhook straddle is best-effort: an alert failure never breaks the write --


class _WriteRecordingRepo:
    def save_failed_transactions(self, rows):
        pass

    def insert_or_reconcile(self, txns):
        self.wrote = True


def _raise(*a, **k):
    raise RuntimeError("boom")


def test_capture_failure_does_not_break_the_write(lam, monkeypatch):
    monkeypatch.setattr(lam.budget_alerts, "capture_pre_write", _raise)
    repo = _WriteRecordingRepo()
    lam.handler.process_transaction({"id": "e1", "data": []}, repo)  # must not raise
    assert repo.wrote is True


def test_fire_failure_does_not_break_the_write(lam, monkeypatch):
    monkeypatch.setattr(lam.budget_alerts, "capture_pre_write", lambda *a, **k: {"stub": True})
    monkeypatch.setattr(lam.budget_alerts, "fire_if_crossed", _raise)
    repo = _WriteRecordingRepo()
    lam.handler.process_transaction({"id": "e1", "data": []}, repo)  # must not raise
    assert repo.wrote is True


# ===========================================================================
# QA gap tests (WHIT-22) — the reconcile-fidelity of _simulate_after against
# the REAL webhook TransactionRepository, plus boundary / window / refund /
# pagination gaps. The implementer's tests use NoTwinRepo (the reconcile path is
# never exercised); these seed a real pending twin into a FakeTable so
# _find_pending_twin / _with_carried_category run for real inside the Δ sim.
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
    return alerts.banksync.BankSyncClient.normalise(_bank(**kw))


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


def test_linked_settlement_carries_category_and_uses_settled_amount(alerts, repo, monkeypatch):
    # Explicit-link settlement (reconcile tier 1) isolates carry+Δ from the tip
    # heuristic: pendingTransactionId points at the twin, so the amount may grow freely.
    # Pending -70 groceries, posted -85 raw "GROCERIES" linked to it. Correct Δ: twin
    # removed + posted-as-groceries added → 85, crosses 80. Fires exactly the 80 push.
    _seed(repo, alerts, txn_id="A", amount=Decimal("-70"), pending=True, category="groceries")
    before = list(repo._table.store.values())
    posted = _norm_real(alerts, txn_id="B", amount=Decimal("-85"), pending=False,
                        category="GROCERIES", pending_transaction_id="A")
    sent, _, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("100")}},
                      before=before, normalised=[posted], webhook_repo=repo)
    assert len(sent) == 1
    assert sent[0][0] == "Heads up \U0001f440"


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


# --- refund / already-over-threshold: negative & non-re-firing crossings -----


def test_refund_lowers_spend_and_never_fires(alerts, monkeypatch):
    # A refund (POSITIVE amount) makes after < before. No threshold can be newly
    # crossed downward. Before $85 (already over 80%), a +$20 refund -> $65 -> silent.
    before = [_txn("old", "groceries", -85, "posted")]
    refund = _txn("r1", "groceries", 20, "posted")  # positive => a credit/refund
    sent, _, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("100")}},
                      before=before, normalised=[refund])
    assert sent == []


def test_already_over_threshold_at_cycle_start_does_not_refire(alerts, monkeypatch):
    # before is ALREADY past 80% ($85). More spend ($5 -> $90) must NOT re-fire 80%
    # (before is not < 0.8*target) and hasn't reached 100%. Silent. Guards the
    # `before < T*target` left bound against a spurious repeat alert.
    before = [_txn("old", "groceries", -85, "posted")]
    more = _txn("new1", "groceries", -5, "posted")
    sent, _, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("100")}},
                      before=before, normalised=[more])
    assert sent == []


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


def test_crossing_is_inclusive_at_exactly_the_threshold(alerts, monkeypatch):
    # Combined lands EXACTLY on 80% of target ($79 -> $80 == 0.8*100). The crossing
    # test is `before < T <= after`, so exactly-at fires. Locks the `<=` boundary.
    before = [_txn("old", "groceries", -79, "posted")]
    new = _txn("new1", "groceries", -1, "posted")
    sent, _, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("100")}},
                      before=before, normalised=[new])
    assert len(sent) == 1


def test_one_cent_under_threshold_does_not_fire(alerts, monkeypatch):
    # The complement: $79.99 (< $80) must not fire — proves the boundary test isn't
    # a `<=` on the wrong side.
    before = [_txn("old", "groceries", -79, "posted")]
    new = _txn("new1", "groceries", "-0.99", "posted")  # -> 79.99
    sent, _, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("100")}},
                      before=before, normalised=[new])
    assert sent == []


# --- target <= 0 guard & budgeted-but-unspent category -----------------------


def test_zero_target_budget_never_fires(alerts, monkeypatch):
    # A non-positive target is already unfireable (b >= 0 clamp + the `b <` left bound
    # mean `b < frac*target <= 0` never holds); the explicit target<=0 skip is
    # belt-and-suspenders. $100 spend, $0 target -> silent either way.
    new = _txn("new1", "groceries", -100, "posted")
    sent, _, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("0")}},
                      before=[], normalised=[new])
    assert sent == []


def test_negative_target_budget_never_fires(alerts, monkeypatch):
    new = _txn("new1", "groceries", -100, "posted")
    sent, _, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("-50")}},
                      before=[], normalised=[new])
    assert sent == []


def test_budgeted_category_with_no_spend_is_not_a_crossing(alerts, monkeypatch):
    # Two budgets; only groceries crosses. `coffee` has zero spend anywhere — _combined
    # must treat its absent summary as $0 (not KeyError) and not fire. Locks _combined's
    # None-entry fallback for a budgeted-but-untouched category.
    budgets = {"groceries": {"target": Decimal("100")}, "coffee": {"target": Decimal("50")}}
    before = [_txn("g", "groceries", -70, "posted")]
    new = _txn("g2", "groceries", -15, "posted")
    cats = [{"id": "groceries", "name": "Groceries"}, {"id": "coffee", "name": "Coffee"}]
    sent, _, _ = _run(alerts, monkeypatch, budgets=budgets, before=before, normalised=[new], cats=cats)
    assert len(sent) == 1
    assert "Groceries" in sent[0][1]


# --- windowed read: cursor pagination + the bounded backstop -----------------


class _CursorWindowRepo:
    """A date-range read that returns ONE row per page and follows an integer cursor
    to completion — so a crossing is only detectable if _window_rows accumulates
    every page, not just the first."""

    def __init__(self, rows):
        self._rows = rows

    def get_transactions_by_date_range(self, account_id, start, end, limit=100, cursor=None):
        mine = [r for r in self._rows if r["account_id"] == account_id]
        i = cursor or 0
        if i >= len(mine):
            return ([], None)
        nxt = i + 1
        return ([mine[i]], (nxt if nxt < len(mine) else None))


def test_window_read_accumulates_every_cursor_page(alerts, monkeypatch):
    ba = alerts.budget_alerts
    sent = []
    monkeypatch.setattr(ba, "send_push", lambda t, b, toks: sent.append((t, b)))
    # Two pre-write rows ($35 + $35 = $70) split across two pages; the new $15 pushes
    # the total to $85 -> crosses 80. If page 2 were dropped, before=$35 -> after=$50 ->
    # no crossing. So a passing send proves both pages were read.
    rows = [_txn("r0", "groceries", -35, "posted"), _txn("r1", "groceries", -35, "posted")]
    new = _txn("new1", "groceries", -15, "posted")
    ctx = ba.capture_pre_write(
        [new], device_repo=FakeDeviceRepo(),
        budget_repo=FakeBudgetRepo({"groceries": {"target": Decimal("100")}}),
        paycycle_repo=FakePaycycleRepo(), window_repo=_CursorWindowRepo(rows), webhook_repo=NoTwinRepo(),
    )
    assert len(ctx["before_rows"]) == 2  # both pages accumulated
    ba.fire_if_crossed(ctx, [new], webhook_repo=NoTwinRepo(),
                       category_repo=FakeCategoryRepo([{"id": "groceries", "name": "Groceries"}]),
                       notify_repo=FakeNotifyRepo())
    assert len(sent) == 1


def test_window_read_backstop_raises_on_a_nonterminating_cursor(alerts):
    ba = alerts.budget_alerts

    class _NeverEnds:
        def get_transactions_by_date_range(self, account_id, start, end, limit=100, cursor=None):
            return ([], "always-more")  # a cursor that never clears

    with pytest.raises(RuntimeError, match="did not terminate"):
        ba.capture_pre_write(
            [_txn("n", "groceries", -1, "posted")], device_repo=FakeDeviceRepo(),
            budget_repo=FakeBudgetRepo({"groceries": {"target": Decimal("100")}}),
            paycycle_repo=FakePaycycleRepo(), window_repo=_NeverEnds(), webhook_repo=NoTwinRepo(),
        )


# --- spend.py move regression: the relocated helpers behave identically ------
# (Boundary behaviour of the window is also locked by lambda_api/test_budgets.py,
#  which now patches `spend`; these assert the SAME functions from the webhook side.)


def test_current_cycle_window_boundaries_from_shared_spend(alerts):
    import spend
    # payday inclusive, today inclusive, tomorrow excluded.
    assert spend.current_cycle_window("2026-07-01", 14, today=date(2026, 7, 14)) == ("2026-07-01", "2026-07-14")
    # rollover: one day past the cycle end starts a fresh single-day window.
    assert spend.current_cycle_window("2026-07-01", 14, today=date(2026, 7, 15)) == ("2026-07-15", "2026-07-15")


def test_summarise_transactions_clamps_refund_and_splits_buckets(alerts):
    import spend
    txns = [
        {"category": "groceries", "amount": Decimal("-40"), "status": "posted", "counts_to_budget": True},
        {"category": "groceries", "amount": Decimal("-10"), "status": "pending", "counts_to_budget": True},
        {"category": "groceries", "amount": Decimal("100"), "status": "posted", "counts_to_budget": True},  # big refund
    ]
    out = spend.summarise_transactions(txns, {"groceries"})
    assert out["groceries"]["pending"] == Decimal("10")
    assert out["groceries"]["posted"] == Decimal("0")  # -40 net +100 refund => -60, clamped to 0
