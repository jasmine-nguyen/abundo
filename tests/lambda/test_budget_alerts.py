"""Budget-threshold alert detection (shared/budget_alerts.py), WHIT-22.

Driven through the webhook `lam` fixture (so budget_alerts + the real webhook repo
reconcile primitives are importable). `spend._melbourne_today` is pinned so the
cycle window is deterministic. `send_push` is stubbed to capture pushes.

The load-bearing test is `test_crossing_fires_via_delta_not_a_reread`: the fake
window repo returns ONLY the pre-write rows (it never sees the just-written row),
so the post-write spend level can only come from the in-memory replay — locking that the
alert is immune to the date-index GSI's eventual consistency.
"""

from datetime import date
from decimal import Decimal

import pytest
from _budget_alert_fakes import FakeNotifyRepo

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


def _real_inherit_swipe_date(merged, posted_txn, source_row):
    """The production implementation, resolved lazily (the webhook modules are only
    importable once the `lam` fixture has put the lambda dirs on sys.path)."""
    import repository
    return repository.TransactionRepository._inherit_swipe_date(merged, posted_txn, source_row)


class NoTwinRepo:
    """webhook_repo stand-in: no pending twins, carries no category."""

    def get_pending_transactions_for_account(self, account):
        return []

    def _reconcile_matches(self, posted_txns, pools):
        # WHIT-117: _simulate_after now drives the batch matcher; no twins here.
        return [(txn, None) for txn in posted_txns]

    @staticmethod
    def _with_carried_category(txn, src):
        return dict(txn)

    # Delegated, never re-implemented: a hand-copied version silently goes stale (it
    # missed the WHIT-331 skew branch entirely), so every alert test using this stand-in
    # would assert against the copy instead of production.
    _inherit_swipe_date = staticmethod(_real_inherit_swipe_date)


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
    ba.fire_budget_alerts(
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


def test_crossing_push_carries_budget_deeplink_data(alerts, monkeypatch):
    # WHIT-322: the push carries data={"type": "budget", "category": <cat_id>} so a tap opens
    # THAT category's budget screen (/budget/<cat_id>).
    ba = alerts.budget_alerts
    captured = []
    monkeypatch.setattr(ba, "send_push",
                        lambda title, body, toks, data=None: captured.append(data) or
                        {"sent": len(list(toks)), "ok": 1, "pruned": []})
    before = [_txn("old", "groceries", -70, "posted")]
    new = _txn("new1", "groceries", -15, "posted")
    ctx = ba.capture_pre_write(
        [new],
        device_repo=FakeDeviceRepo(("ExpoPushToken[a]",)),
        budget_repo=FakeBudgetRepo({"groceries": {"target": Decimal("100")}}),
        paycycle_repo=FakePaycycleRepo("2026-07-01", 14),
        window_repo=FakeWindowRepo(before),
        webhook_repo=NoTwinRepo(),
    )
    ba.fire_budget_alerts(
        ctx, [new], webhook_repo=NoTwinRepo(),
        category_repo=FakeCategoryRepo([{"id": "groceries", "name": "Groceries"}]),
        notify_repo=FakeNotifyRepo(),
    )
    assert captured == [{"type": "budget", "category": "groceries"}]


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


def test_income_floor_target_never_fires_an_alert(alerts, monkeypatch):
    # WHIT-69: a target on an Income category is an earn-target (a floor), not a spend
    # ceiling. Income-bucket targets are excluded from the crossing check, so a big
    # paycheck never trips the 80%/100% "you've spent your budget" thresholds.
    new = _txn("pay1", "salary", 6000, "posted")  # income >> the 5000 target
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"salary": {"target": Decimal("5000")}},
                           before=[], normalised=[new],
                           cats=[{"id": "salary", "name": "Salary", "bucket": "Income"}])
    assert sent == []
    assert notify.fired_markers("2026-07-01", 14) == set()


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


def test_spend_alert_fires_alongside_an_excluded_savings_target(alerts, monkeypatch):
    # WHIT-201 regression (qa gap): excluding Savings-bucket targets from the crossing
    # check must NOT suppress a real spend crossing in the SAME batch. Groceries crosses
    # 80% while a spend mis-filed into a Savings category is (correctly) ignored — exactly
    # one push, for spend. Guards against a filter change that over-drops the live target.
    spend_new = _txn("g1", "groceries", -85, "posted")    # 85% of the 100 ceiling -> 80%
    savings_new = _txn("s1", "nest_egg", -85, "posted")   # mis-filed to Savings -> silent
    sent, notify, _ = _run(
        alerts, monkeypatch,
        budgets={"groceries": {"target": Decimal("100")}, "nest_egg": {"target": Decimal("100")}},
        before=[], normalised=[spend_new, savings_new],
        cats=[{"id": "groceries", "name": "Groceries", "bucket": "Living"},
              {"id": "nest_egg", "name": "Nest Egg", "bucket": "Savings"}],
    )
    assert len(sent) == 1
    assert sent[0][1] == "Groceries is at 80% of its budget this cycle."
    assert notify.fired_markers("2026-07-01", 14) == {"groceries#80"}  # no nest_egg marker


def test_orphan_income_target_clawback_does_not_fire(alerts, monkeypatch):
    # WHIT-168: an income earn-target whose category was DELETED but whose budget row
    # survived a failed best-effort cascade is an "orphan" — its id is in targets but
    # absent from the live taxonomy. The alert path can no longer see bucket == Income,
    # so a lone negative clawback (-4000 → +4000 read as spend) would cross 0.8*5000 and
    # fire a false push. The live-category membership filter drops the orphan → silent.
    # Fails on the pre-WHIT-168 `set(targets) - income_ids` code (orphan not in income_ids).
    new = _txn("rev1", "salary", -4000, "posted")  # clawback under a now-deleted income cat
    sent, notify, _ = _run(
        alerts, monkeypatch, budgets={"salary": {"target": Decimal("5000")}},
        before=[], normalised=[new],
        cats=[{"id": "groceries", "name": "Groceries", "bucket": "Living"}],  # salary NOT here
    )
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


def test_spend_alert_still_fires_alongside_an_excluded_income_target(alerts, monkeypatch):
    # WHIT-69 regression (authored by qa): excluding Income-bucket targets from the
    # crossing check must NOT suppress a real spend crossing in the SAME batch.
    # Groceries crosses 80% while the income Salary paycheck is (correctly) ignored —
    # exactly one push, for spend.
    spend_new = _txn("g1", "groceries", -85, "posted")   # 85% of the 100 ceiling -> 80%
    income_new = _txn("s1", "salary", 6000, "posted")     # well over the 5000 floor -> silent
    sent, notify, _ = _run(
        alerts, monkeypatch,
        budgets={"groceries": {"target": Decimal("100")}, "salary": {"target": Decimal("5000")}},
        before=[], normalised=[spend_new, income_new],
        cats=[{"id": "groceries", "name": "Groceries", "bucket": "Living"},
              {"id": "salary", "name": "Salary", "bucket": "Income"}],
    )
    assert len(sent) == 1
    assert sent[0][1] == "Groceries is at 80% of its budget this cycle."
    assert notify.fired_markers("2026-07-01", 14) == {"groceries#80"}  # no salary marker


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
    assert sent[0][0] == "Budget hit"
    assert notify.fired_markers("2026-07-01", 14) == {"groceries#80", "groceries#100"}


# --- WHIT-154 mark-on-landing: a failed send must NOT mark fired ------------


def test_send_failure_marks_no_marker(alerts, monkeypatch):
    # A single 80% crossing whose send fails (ok == 0): the attempt is made but no
    # marker is written, so the crossing stays eligible. Fail-on-revert: an
    # unconditional mark_fired leaves {"groceries#80"}.
    before = [_txn("old", "groceries", -70, "posted")]
    new = _txn("new1", "groceries", -15, "posted")
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("100")}},
                           before=before, normalised=[new], send_ok=0)
    assert len(sent) == 1                                          # send attempted
    assert notify.fired_markers("2026-07-01", 14) == set()        # nothing marked


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


def test_primary_already_fired_repairs_secondary_without_a_new_send(alerts, monkeypatch):
    # A prior ingest already delivered + marked the 100% push, but the 80% marker is
    # missing (e.g. it crossed both at once but only 100% was marked before a crash).
    # A re-ingest that re-detects the double crossing must repair the 80% marker
    # WITHOUT sending again — the `send_marker in fired` branch treats it as landed.
    notify = FakeNotifyRepo()
    notify.mark_fired("2026-07-01", 14, "groceries#100")  # delivered earlier
    new = _txn("new1", "groceries", -100, "posted")
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("100")}},
                           before=[], normalised=[new], notify=notify)
    assert sent == []                                             # no second push
    assert notify.fired_markers("2026-07-01", 14) == {"groceries#80", "groceries#100"}


def test_budget_send_failure_retries_at_the_next_delivery(alerts, monkeypatch):
    # WHIT-577: a failed send releases its claim, and the next delivery re-checks the LEVEL,
    # so the alert is retried even once the GSI has caught up with the first write.
    # Fail-on-revert: drop release_fired (or go back to firing only on a crossing) → no retry.
    budgets = {"groceries": {"target": Decimal("100")}}
    new = _txn("new1", "groceries", -15, "posted")

    # Delivery 1: Expo down. $70 → $85 reaches 80% → attempted, claim released.
    notify = FakeNotifyRepo()
    before_lagging = [_txn("old", "groceries", -70, "posted")]
    sent1, notify, _ = _run(alerts, monkeypatch, budgets=budgets,
                            before=before_lagging, normalised=[new], notify=notify, send_ok=0)
    assert len(sent1) == 1 and notify.fired_markers("2026-07-01", 14) == set()
    assert notify.released == ["groceries#80"]

    # Delivery 2: the GSI has caught up ($85 already stored). Still at 80%, still unmarked → retried.
    before_caught_up = [_txn("old", "groceries", -70, "posted"), _txn("new1", "groceries", -15, "posted")]
    sent2, notify, _ = _run(alerts, monkeypatch, budgets=budgets,
                            before=before_caught_up, normalised=[new], notify=notify, send_ok=1)
    assert [title for title, _, _ in sent2] == ["Heads up \U0001f440"]
    assert notify.fired_markers("2026-07-01", 14) == {"groceries#80"}


# --- WHIT-154 gaps (qa): multi-category partial failure + marker interactions ----


def test_combined_push_that_fails_releases_every_claim(alerts, monkeypatch):
    # Two budgets reach 80% in ONE write → one combined push. It fails (ok == 0), so BOTH
    # claims are released and both stay eligible for the next delivery (WHIT-154/577).
    # Fail-on-revert: skipping the release leaves both markers claimed → never retried.
    budgets = {"groceries": {"target": Decimal("100")}, "dining": {"target": Decimal("100")}}
    normalised = [_txn("g1", "groceries", -85, "posted"), _txn("d1", "dining", -85, "posted")]
    cats = [{"id": "groceries", "name": "Groceries", "bucket": "Living"},
            {"id": "dining", "name": "Dining", "bucket": "Living"}]
    sent, notify, _ = _run(alerts, monkeypatch, budgets=budgets, before=[], normalised=normalised,
                           cats=cats, send_ok=0)
    assert len(sent) == 1                                               # one combined attempt
    assert notify.fired_markers("2026-07-01", 14) == set()
    assert sorted(notify.released) == ["dining#80", "groceries#80"]


def test_budget_fully_pruned_ok_zero_leaves_unmarked(alerts, monkeypatch):
    # ok == 0 because every token was DeviceNotRegistered (pruned), NOT a transport
    # error. The gate keys ONLY on ok > 0, so the pruned reason is invisible: still no
    # marker, exactly like an outage. Fail-on-revert: an unconditional mark writes
    # groceries#80.
    ba = alerts.budget_alerts
    sent = []

    def fake_send(title, body, toks, data=None):
        toks = list(toks)
        sent.append((title, body, toks))
        return {"sent": len(toks), "ok": 0, "pruned": toks}  # all dead tokens

    monkeypatch.setattr(ba, "send_push", fake_send)
    notify = FakeNotifyRepo()
    webhook_repo = NoTwinRepo()
    before = [_txn("old", "groceries", -70, "posted")]
    new = _txn("new1", "groceries", -15, "posted")            # -> $85, crosses 80%
    ctx = ba.capture_pre_write(
        [new], device_repo=FakeDeviceRepo(), budget_repo=FakeBudgetRepo({"groceries": {"target": Decimal("100")}}),
        paycycle_repo=FakePaycycleRepo("2026-07-01", 14),
        window_repo=FakeWindowRepo(before), webhook_repo=webhook_repo,
    )
    ba.fire_budget_alerts(ctx, [new], webhook_repo=webhook_repo,
                       category_repo=FakeCategoryRepo([{"id": "groceries", "name": "Groceries"}]),
                       notify_repo=notify)
    assert len(sent) == 1                                     # attempted
    assert notify.fired_markers("2026-07-01", 14) == set()    # pruned ok==0 => still unmarked


def test_higher_send_fails_leaves_100_eligible_with_lower_fired(alerts, monkeypatch):
    # Marker interaction: 80% already fired earlier this cycle; a new write vaults to
    # 100% but that send fails (ok == 0). The `continue` must run BEFORE the secondary
    # loop, so NO groceries#100 marker is written — 100% stays eligible to retry within
    # GSI lag, and the stale 80% marker is untouched. Fail-on-revert writes groceries#100.
    notify = FakeNotifyRepo()
    notify.mark_fired("2026-07-01", 14, "groceries#80")       # 80% delivered earlier
    before = [_txn("old", "groceries", -85, "posted")]        # already past 80%
    new = _txn("new1", "groceries", -20, "posted")            # -> $105, crosses 100%
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("100")}},
                           before=before, normalised=[new], notify=notify, send_ok=0)
    assert len(sent) == 1                                             # 100% send attempted
    assert notify.fired_markers("2026-07-01", 14) == {"groceries#80"}  # no #100 written


def test_claim_precedes_send_and_lower_marks_follow_it(alerts, monkeypatch):
    # The marker is CLAIMED before the send (so an overlapping delivery can't also send it);
    # the lower-threshold mark only follows a push that landed.
    ba = alerts.budget_alerts
    order = []
    monkeypatch.setattr(ba, "send_push", lambda *a, **k: (order.append("send"), {"sent": 1, "ok": 1, "pruned": []})[1])
    notify = FakeNotifyRepo()
    original_claim, original_mark = notify.claim_fired, notify.mark_fired
    notify.claim_fired = lambda *a: (order.append("claim"), original_claim(*a))[1]
    notify.mark_fired = lambda *a: (order.append("mark"), original_mark(*a))[1]
    before = [_txn("old", "groceries", -90, "posted")]
    new = _txn("new1", "groceries", -15, "posted")                     # → $105, both thresholds
    ctx = ba.capture_pre_write(
        [new], device_repo=FakeDeviceRepo(), budget_repo=FakeBudgetRepo({"groceries": {"target": Decimal("100")}}),
        paycycle_repo=FakePaycycleRepo(), window_repo=FakeWindowRepo(before), webhook_repo=NoTwinRepo(),
    )
    ba.fire_budget_alerts(ctx, [new], webhook_repo=NoTwinRepo(),
                          category_repo=FakeCategoryRepo([{"id": "groceries", "name": "Groceries"}]), notify_repo=notify)
    assert order == ["claim", "send", "mark"]


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


def test_fire_budget_alerts_ignores_a_none_context(alerts, monkeypatch):
    ba = alerts.budget_alerts
    monkeypatch.setattr(ba, "send_push", lambda *a, **k: (_ for _ in ()).throw(AssertionError("no send")))
    ba.fire_budget_alerts(None, [], webhook_repo=NoTwinRepo(),
                       category_repo=FakeCategoryRepo([]), notify_repo=FakeNotifyRepo())  # no raise


# --- the webhook straddle is best-effort: an alert failure never breaks the write --


class _WriteRecordingRepo:
    def save_failed_transactions(self, rows):
        pass

    def insert_or_reconcile(self, txns, *, is_unfiled=None):
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
    monkeypatch.setattr(lam.budget_alerts, "fire_budget_alerts", _raise)
    repo = _WriteRecordingRepo()
    lam.handler.process_transaction({"id": "e1", "data": []}, repo)  # must not raise
    assert repo.wrote is True


# ===========================================================================
# QA gap tests (WHIT-22) — the reconcile-fidelity of _simulate_after against
# the REAL webhook TransactionRepository, plus boundary / window / refund /
# pagination gaps. The implementer's tests use NoTwinRepo (the reconcile path is
# never exercised); these seed a real pending twin into a FakeTable so
# _reconcile_matches / _with_carried_category run for real inside the Δ sim.
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


def test_simulate_after_two_pass_matches_real_write_on_starvation_batch(alerts, repo, monkeypatch):
    # WHIT-117 sim fidelity: _simulate_after must reproduce the two-pass exactly where it
    # matters — a starvation batch. Pending -70 "groceries". Batch order: tip -80 FIRST,
    # exact -70 SECOND (raw "FOOD_AND_DRINK" on both; only the carried groceries counts).
    #   two-pass (correct): exact -70 pops the pending -> carries groceries -> groceries
    #     combined = 70 (< 80) -> NO alert.
    #   single-pass (bug):  tip -80 pops the pending first -> carries groceries onto -80 ->
    #     groceries combined = 80 -> FIRES the 80 push.
    # Asserting NO alert makes the sim's two-pass a hard gate: revert it and this fires.
    _seed(repo, alerts, txn_id="A", amount=Decimal("-70"), pending=True, category="groceries")
    before = list(repo._table.store.values())
    tip_first = _norm_real(alerts, txn_id="B", amount=Decimal("-80"), pending=False, category="FOOD_AND_DRINK")
    exact_second = _norm_real(alerts, txn_id="C", amount=Decimal("-70"), pending=False, category="FOOD_AND_DRINK")
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("100")}},
                           before=before, normalised=[tip_first, exact_second], webhook_repo=repo)
    assert sent == []                                       # groceries = 70 < 80, exact won the carry
    assert notify.fired_markers("2026-07-01", 14) == set()


def test_simulate_after_two_pass_survives_interleaved_pending(alerts, repo, monkeypatch):
    # WHIT-117 sim GAP (authored by qa): the implementer's sim starvation test has the tip
    # and exact postings ADJACENT. This inserts a NEW pending row BETWEEN them in
    # `normalised`, so the two-pass must still resolve exact-before-tip with an interleaved
    # pending in the batch. The hard gate is the ordering (RED on a single-pass revert); the
    # interleaved pending just makes it realistic. NOTE: this does NOT independently lock
    # iterator alignment — the defensive `next(..., (None, None))` default would mask a
    # misadvance — it's an end-state check.
    #   two-pass (correct): exact -70 (C) claims the pending -> groceries combined = 70
    #     (< 80) -> NO push. The interleaved pending is unbudgeted "dining" -> ignored.
    #   single-pass (revert): tip -80 (T) claims the pending -> groceries = 80 -> FIRES.
    _seed(repo, alerts, txn_id="A", amount=Decimal("-70"), pending=True, category="groceries")
    before = list(repo._table.store.values())
    tip_first = _norm_real(alerts, txn_id="T", amount=Decimal("-80"),
                           pending=False, category="FOOD_AND_DRINK")
    mid_pending = _norm_real(alerts, txn_id="D", amount=Decimal("-50"), pending=True,
                             category="dining", merchant_name="OTHER MERCHANT",
                             description="OTHER MERCHANT")
    exact_second = _norm_real(alerts, txn_id="C", amount=Decimal("-70"),
                              pending=False, category="FOOD_AND_DRINK")
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("100")}},
                           before=before, normalised=[tip_first, mid_pending, exact_second],
                           webhook_repo=repo)
    assert sent == []                                        # exact won the carry; 70 < 80
    assert notify.fired_markers("2026-07-01", 14) == set()


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


def test_already_over_but_never_warned_fires_once_then_stays_quiet(alerts, monkeypatch):
    # WHIT-577 (Jas's bug): spend is ALREADY past 80% ($85) — filed in the app, where no alert
    # runs — and no marker exists. The next delivery, even one that adds only $5, must warn
    # once; a later delivery must stay silent. Fail-on-revert: fire only on a crossing
    # (before < line <= after) and the first run is silent.
    before = [_txn("old", "groceries", -85, "posted")]
    more = _txn("new1", "groceries", -5, "posted")
    notify = FakeNotifyRepo()
    sent1, notify, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("100")}},
                            before=before, normalised=[more], notify=notify)
    assert [title for title, _, _ in sent1] == ["Heads up \U0001f440"]

    sent2, _, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("100")}},
                       before=before + [more], normalised=[], notify=notify)
    assert sent2 == []


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
    # Two budgets; only groceries crosses. `coffee` has zero spend anywhere — _combined_target
    # must treat its absent summary as $0 (not KeyError) and not fire, via its `if cid in spend`
    # skip. Locks the absent-id-contributes-0 behaviour for a budgeted-but-untouched category.
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
    monkeypatch.setattr(ba, "send_push",
                        lambda t, b, toks, data=None: (sent.append((t, b)), {"sent": len(list(toks)), "ok": len(list(toks)), "pruned": []})[1])
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
    ba.fire_budget_alerts(ctx, [new], webhook_repo=NoTwinRepo(),
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
    notify = FakeNotifyRepo()
    notify.mark_fired("2026-06-04", 14, "groceries#80")   # stale marker under the raw payday
    sent, notify, ctx = _run(alerts, monkeypatch,
                             budgets={"groceries": {"target": Decimal("100")}},
                             before=before, normalised=[new], paycycle=("2026-06-04", 14), notify=notify)
    assert len(sent) == 1                                          # fires — NOT suppressed by the stale marker
    assert notify.fired_markers("2026-07-02", 14) == {"groceries#80"}


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


def test_parent_rollup_multilevel_grandchild_fires(alerts, monkeypatch):
    # car -> daily -> {petrol, tolls}; only car budgeted. A grandchild leaf's spend
    # must reach car through the two-level walk.
    cats = [
        {"id": "car", "name": "Car", "bucket": "Living", "parent": None},
        {"id": "daily", "name": "Daily", "bucket": "Living", "parent": "car"},
        {"id": "petrol", "name": "Petrol", "bucket": "Living", "parent": "daily"},
        {"id": "tolls", "name": "Tolls", "bucket": "Living", "parent": "daily"},
    ]
    before = [_txn("old", "petrol", -70, "posted")]
    new = _txn("new1", "tolls", -15, "posted")                    # 85 rolled to car
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"car": {"target": Decimal("100")}},
                           before=before, normalised=[new], cats=cats)
    assert len(sent) == 1
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


def test_parent_and_leaf_both_cross_fire_both(alerts, monkeypatch):
    # When BOTH the parent's total and the sub genuinely cross on one write, both are warned —
    # they're separate budgets, each a real fact (one combined push). Car 50 + Fuel 50; fuel 45 crosses both.
    before = [_txn("old", "fuel", -35, "posted")]
    new = _txn("new1", "fuel", -10, "posted")                     # fuel & car both 45
    sent, notify, _ = _run(alerts, monkeypatch,
                           budgets={"car": {"target": Decimal("50")}, "fuel": {"target": Decimal("50")}},
                           before=before, normalised=[new], cats=_CAR_TREE)
    assert [body for _, body, _ in sent] == ["Car, Fuel are at 80% or more of their budget this cycle."]
    assert notify.fired_markers("2026-07-01", 14) == {"car#80", "fuel#80"}


def test_parent_vault_past_both_thresholds_marks_both(alerts, monkeypatch):
    # A parent rollup jumping 0 -> 100% in one write sends only the 100% push but marks
    # both car#80 and car#100 (the vault behaviour, now for a parent).
    before = []
    new = _txn("new1", "fuel", -100, "posted")                    # car 100 = 100% of 100
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"car": {"target": Decimal("100")}},
                           before=before, normalised=[new], cats=_CAR_TREE)
    assert len(sent) == 1
    assert sent[0][0] == "Budget hit"
    assert sent[0][1] == "You've spent your whole Car budget for this cycle."
    assert notify.fired_markers("2026-07-01", 14) == {"car#80", "car#100"}


def test_income_parent_never_fires(alerts, monkeypatch):
    # An Income-bucket PARENT is a floor (over-is-good), never a spend ceiling — no
    # 80/100% push, same as an Income leaf (WHIT-69).
    cats = [
        {"id": "income", "name": "Income", "bucket": "Income", "parent": None},
        {"id": "salary", "name": "Salary", "bucket": "Income", "parent": "income"},
    ]
    before = [_txn("old", "salary", 4000, "posted")]
    new = _txn("new1", "salary", 3000, "posted")                  # positive earnings
    sent, _, _ = _run(alerts, monkeypatch, budgets={"income": {"target": Decimal("5000")}},
                      before=before, normalised=[new], cats=cats)
    assert sent == []


def test_savings_parent_never_fires(alerts, monkeypatch):
    # A Savings-bucket PARENT never fires either — a mis-filed spend on a Savings sub
    # must not read as spend against the target (WHIT-201).
    cats = [
        {"id": "nest", "name": "Nest Egg", "bucket": "Savings", "parent": None},
        {"id": "holiday", "name": "Holiday", "bucket": "Savings", "parent": "nest"},
    ]
    before = [_txn("old", "holiday", -800, "posted")]
    new = _txn("new1", "holiday", -300, "posted")
    sent, _, _ = _run(alerts, monkeypatch, budgets={"nest": {"target": Decimal("1000")}},
                      before=before, normalised=[new], cats=cats)
    assert sent == []


def test_leaf_only_budget_unchanged_with_sibling_tree_present(alerts, monkeypatch):
    # Regression: a leaf-only budget (groceries, no children) fires byte-identically even
    # when an unrelated budgeted parent tree exists in the taxonomy — the union of needed
    # leaves must not leak another family's spend into this target.
    cats = [
        {"id": "groceries", "name": "Groceries", "bucket": "Living", "parent": None},
    ] + _CAR_TREE
    before = [_txn("old", "groceries", -70, "posted"), _txn("f", "fuel", -999, "posted")]
    new = _txn("new1", "groceries", -15, "posted")                # groceries 85%
    sent, notify, _ = _run(alerts, monkeypatch,
                           budgets={"groceries": {"target": Decimal("100")}},
                           before=before, normalised=[new], cats=cats)
    assert len(sent) == 1
    assert sent[0][1] == "Groceries is at 80% of its budget this cycle."
    assert notify.fired_markers("2026-07-01", 14) == {"groceries#80"}


# ===========================================================================
# QA GAP tests (WHIT-222) — adversarial edges the implementer's parent-rollup
# tests don't cover: reconcile (settlement) Δ folded into a parent, refund /
# per-leaf >=0 clamp interacting with the parent fold, leaves across MULTIPLE
# accounts, the parent's fired-marker keyed on the PARENT id (cross-leaf
# debounce), and a mid-node + its parent both crossing off one shared leaf.
# Every parent-fold assertion falls silent on a revert to the per-leaf sum.
# ===========================================================================


def _txn_on(txn_id, category, amount, status, account, date="2026-07-10"):
    """A leaf transaction on a SPECIFIC account (parent leaves can span cards)."""
    t = _txn(txn_id, category, amount, status, date)
    t["account_id"] = account
    return t


# --- settlement (reconcile Δ) folded into a budgeted parent ------------------


def test_parent_settlement_twin_crosses_parent_and_carries_category(alerts, repo, monkeypatch):
    # WHIT-222 x reconcile: a pending->posted settlement on a LEAF must cross the
    # PARENT via the twin-reconcile Δ, not a naive add. Pending fuel -70 (car=70<80).
    # Posted -85 (tip, within 70*1.25) with raw "GROCERIES" carries the pending's
    # "fuel". Correct Δ: twin removed (70) + posted-as-fuel (85) => fuel 85 => car 85,
    # crosses 80. Falsifies 3 ways: no rollup -> car=0 -> silent; naive add -> 155 ->
    # the 100 copy; broken tip match -> twin survives -> 155 too.
    _seed(repo, alerts, txn_id="A", amount=Decimal("-70"), pending=True, category="fuel")
    before = list(repo._table.store.values())
    posted = _norm_real(alerts, txn_id="B", amount=Decimal("-85"), pending=False, category="GROCERIES")
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"car": {"target": Decimal("100")}},
                           before=before, normalised=[posted], webhook_repo=repo, cats=_CAR_TREE)
    assert len(sent) == 1
    assert sent[0][0] == "Heads up \U0001f440"           # the 80 copy, NOT the 100 copy
    assert sent[0][1] == "Car is at 80% of its budget this cycle."
    assert notify.fired_markers("2026-07-01", 14) == {"car#80"}


def test_parent_exact_settlement_no_double_count_stays_silent(alerts, repo, monkeypatch):
    # The false-positive guard: an EXACT settlement of a leaf under a budgeted parent
    # must not double-count through the fold. Pending fuel -70, posted -70 exact
    # (carries "fuel"). Correct Δ: twin removed + posted => fuel 70 => car 70 < 80 ->
    # SILENT. A naive before+posted folds to 140 -> a false car#80 AND car#100.
    _seed(repo, alerts, txn_id="A", amount=Decimal("-70"), pending=True, category="fuel")
    before = list(repo._table.store.values())
    posted = _norm_real(alerts, txn_id="B", amount=Decimal("-70"), pending=False, category="GROCERIES")
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"car": {"target": Decimal("100")}},
                           before=before, normalised=[posted], webhook_repo=repo, cats=_CAR_TREE)
    assert sent == []
    assert notify.fired_markers("2026-07-01", 14) == set()


# --- refund / per-leaf >=0 clamp interacting with the parent fold ------------


def test_parent_refund_on_sibling_leaf_cancels_crossing_no_fire(alerts, monkeypatch):
    # A refund on leaf A in the SAME batch nets down the parent rollup and suppresses
    # a crossing that leaf B's spend would otherwise cause. before fuel -70 (car 70).
    # Batch: parking -20 (would push car to 90) + fuel +25 refund -> car = 45(fuel) +
    # 20(parking) = 65 < 80 -> SILENT. Control (no refund) genuinely crosses -> fires,
    # so this fails if the refund is ignored (main fires) OR if the rollup is reverted
    # (control falls silent, car parent == 0).
    before = [_txn("old", "fuel", -70, "posted")]
    batch = [_txn("p", "parking", -20, "posted"), _txn("r", "fuel", 25, "posted")]  # +25 = refund
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"car": {"target": Decimal("100")}},
                           before=before, normalised=batch, cats=_CAR_TREE)
    assert sent == []                                    # refund cancelled the crossing
    assert notify.fired_markers("2026-07-01", 14) == set()

    control, _, _ = _run(alerts, monkeypatch, budgets={"car": {"target": Decimal("100")}},
                         before=before, normalised=[_txn("p", "parking", -20, "posted")], cats=_CAR_TREE)
    assert len(control) == 1                             # same setup DOES cross absent the refund
    assert control[0][1] == "Car is at 80% of its budget this cycle."


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


def test_combined_target_clamps_each_bucket_after_aggregating(alerts):
    # WHIT-343 invariant lock for the alert path: _combined_target sums the subtree UNCLAMPED
    # then floors each bucket ONCE, so a refund-heavy subtree nets before the floor and the
    # alert reads the SAME figure /budgets shows (max(0, sum)). petrol +40 spend, tolls +100
    # refund -> posted nets 40 - 100 = -60 -> clamp once -> 0. Fail-on-revert: the old
    # sum-of-per-id-combined returns -60; a restored per-id clamp (clamp ignored) returns 40.
    import spend, budget_alerts
    txns = [
        _txn("a", "petrol", -40, "posted"),
        _txn("b", "tolls", 100, "posted"),     # refund larger than the subtree's own spend
    ]
    ids = {"car", "petrol", "tolls"}
    per_id = spend.summarise_transactions(txns, ids, clamp=False)
    assert budget_alerts._combined_target(per_id, ids) == Decimal("0")


# --- parent leaves spanning MULTIPLE accounts -------------------------------


def test_parent_rollup_leaves_span_multiple_accounts(alerts, monkeypatch):
    # A parent's leaves can live on different cards. fuel spend on up-spending +
    # parking spend on the ANZ card both fold into Car. before fuel -70 (up-spending,
    # car 70). new parking -15 on the ANZ account -> car 85 -> crosses 80. Proves the
    # window read gathers every account AND the fold is account-agnostic.
    before = [_txn_on("old", "fuel", -70, "posted", "up-spending")]
    new = _txn_on("new1", "parking", -15, "posted", "anz-rewards-black-visa")
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"car": {"target": Decimal("100")}},
                           before=before, normalised=[new], cats=_CAR_TREE)
    assert len(sent) == 1
    assert sent[0][1] == "Car is at 80% of its budget this cycle."
    assert notify.fired_markers("2026-07-01", 14) == {"car#80"}


# --- fired marker is keyed on the PARENT id (cross-leaf debounce) ------------


def test_parent_marker_is_parent_keyed_across_different_leaves(alerts, monkeypatch):
    # The debounce marker for a parent crossing is "car#80" (the parent id), so a
    # second webhook that pushes ANOTHER leaf over must NOT re-alert; but an unrelated
    # LEAF marker (fuel#80) must NOT suppress the parent.
    #   run A: car#80 already fired; before fuel -70, new parking -15 (car 85) -> a
    #          DIFFERENT leaf crosses the parent again -> suppressed (no second push).
    #   run B: only fuel#80 present (a leaf marker); the parent crossing on fuel spend
    #          still fires car#80 -> proves the marker is parent-keyed, not leaf-keyed.
    notify_a = FakeNotifyRepo()
    notify_a.mark_fired("2026-07-01", 14, "car#80")               # parent already alerted
    sent_a, notify_a, _ = _run(alerts, monkeypatch, budgets={"car": {"target": Decimal("100")}},
                               before=[_txn("old", "fuel", -70, "posted")],
                               normalised=[_txn("new1", "parking", -15, "posted")],
                               cats=_CAR_TREE, notify=notify_a)
    assert sent_a == []                                          # parent marker debounces

    notify_b = FakeNotifyRepo()
    notify_b.mark_fired("2026-07-01", 14, "fuel#80")             # a LEAF marker, not the parent
    sent_b, notify_b, _ = _run(alerts, monkeypatch, budgets={"car": {"target": Decimal("100")}},
                               before=[_txn("old", "fuel", -70, "posted")],
                               normalised=[_txn("new1", "fuel", -15, "posted")],
                               cats=_CAR_TREE, notify=notify_b)
    assert len(sent_b) == 1
    assert sent_b[0][1] == "Car is at 80% of its budget this cycle."
    assert notify_b.fired_markers("2026-07-01", 14) == {"fuel#80", "car#80"}


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


def test_parent_direct_pending_settles_to_posted_and_crosses(alerts, repo, monkeypatch):
    # WHIT-228 x reconcile (the parent-direct settlement path, uncovered): a PENDING
    # tagged straight onto the budgeted PARENT `car` (car=70 < 80) settles to a tip-
    # adjusted posted (-85, within 70*1.25) whose raw category is "GROCERIES" but which
    # CARRIES the pending twin's "car". Correct Δ: twin removed (70) + posted-as-car (85)
    # -> car 85 -> crosses 80 -> the 80 push. Fail-on-revert to leaves-only: subtree(car)
    # drops `car` itself, so the car-carried posted is never summed -> car 0 -> silent.
    # A naive before+posted would be 155 (the 100 copy); a broken carry -> 0.
    _seed(repo, alerts, txn_id="A", amount=Decimal("-70"), pending=True, category="car")
    before = list(repo._table.store.values())
    posted = _norm_real(alerts, txn_id="B", amount=Decimal("-85"), pending=False, category="GROCERIES")
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"car": {"target": Decimal("100")}},
                           before=before, normalised=[posted], webhook_repo=repo, cats=_CAR_TREE)
    assert len(sent) == 1
    assert sent[0][0] == "Heads up \U0001f440"           # the 80 copy, NOT the 100 copy
    assert sent[0][1] == "Car is at 80% of its budget this cycle."
    assert notify.fired_markers("2026-07-01", 14) == {"car#80"}


def test_pure_parent_direct_spend_alone_crosses_zero_leaf_spend(alerts, monkeypatch):
    # A pure parent-direct budget: `car` has children in the tree but ALL spend is tagged
    # straight onto `car` itself, zero leaf spend. before car -70 (direct) -> 70; new car
    # -15 (direct) -> 85 -> crosses 80. Fail-on-revert to leaves-only: `car` is not a leaf,
    # so neither write is summed -> car 0 -> silent.
    before = [_txn("old", "car", -70, "posted")]
    new = _txn("new1", "car", -15, "posted")
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"car": {"target": Decimal("100")}},
                           before=before, normalised=[new], cats=_CAR_TREE)
    assert len(sent) == 1
    assert sent[0][1] == "Car is at 80% of its budget this cycle."
    assert notify.fired_markers("2026-07-01", 14) == {"car#80"}


def test_same_bucket_child_fires_while_cross_bucket_sibling_neither_adds_nor_suppresses(alerts, monkeypatch):
    # WHIT-229 GAP: a Living parent (target 100) has BOTH a same-bucket Living child that
    # legitimately crosses 80% (petrol -85) AND a Lifestyle child (odd -30). The same-bucket
    # spend must still fire at 80% and ONLY 80% — the cross-bucket sibling is dropped from the
    # parent's subtree, so it can neither push the parent over 100% nor suppress the real 80%.
    # Fail-on-revert (drop bucket_by_id): odd folds in -> 115 -> crosses 80 AND 100 -> a false
    # extra push and a spurious car#100 marker.
    cats = [
        {"id": "car", "name": "Car", "bucket": "Living", "parent": None},
        {"id": "petrol", "name": "Petrol", "bucket": "Living", "parent": "car"},
        {"id": "odd", "name": "Odd", "bucket": "Lifestyle", "parent": "car"},
    ]
    petrol = _txn("p", "petrol", -85, "posted")   # same-bucket: 85% of Car -> crosses 80
    odd = _txn("o", "odd", -30, "posted")          # cross-bucket: would push Car to 115 if folded
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"car": {"target": Decimal("100")}},
                           before=[], normalised=[petrol, odd], cats=cats)

    assert len(sent) == 1
    assert sent[0][1] == "Car is at 80% of its budget this cycle."
    assert notify.fired_markers("2026-07-01", 14) == {"car#80"}


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


def test_skewed_pair_stays_silent_on_every_resend_of_the_settled_row(alerts, repo, monkeypatch):
    # QA gap: the implementer's test covers only the FIRST settlement. BankSync re-sends a
    # settled row for FEED_WINDOW_DAYS (7 days), and each re-send re-runs the whole alert
    # path against a fresh window read. The live symptom was a push, so "silent once" is
    # not enough — it must stay silent every day of that window, and never record a marker
    # that would then suppress a genuine later crossing.
    _seed(repo, alerts, txn_id="A", amount=Decimal("-70"), pending=True, category="groceries",
          date="2026-07-11", authorized_date="2026-07-11", merchant_name="",
          description="POS AUTHORISATION         SQ *KKV INTERNATIONAL PTYSunshine     AU")
    posted = _norm_real(alerts, txn_id="B", amount=Decimal("-70"), pending=False,
                        category="groceries", date="2026-07-14", authorized_date="2026-07-10",
                        description="SQ *KKV INTERNATIONAL PTY Sunshine",
                        merchant_name="SQ *KKV INTERNATIONAL PTY ")
    notify = FakeNotifyRepo()
    budgets = {"groceries": {"target": Decimal("100")}}

    all_sent = []
    for _ in range(3):  # first settlement, then two verbatim BankSync re-sends
        before = list(repo._table.store.values())
        sent, notify, _ = _run(alerts, monkeypatch, budgets=budgets, before=before,
                               normalised=[posted], webhook_repo=repo, notify=notify)
        all_sent.extend(sent)
        repo.insert_or_reconcile([posted])   # the real write the alert path straddles

    assert all_sent == []
    assert notify.fired_markers("2026-07-01", 14) == set()
    # and the ledger still holds exactly ONE row, on the Melbourne day
    rows = list(repo._table.store.values())
    assert len(rows) == 1
    assert rows[0]["date"] == "2026-07-11"


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
           "pending_pools": {account: list(repo.get_pending_transactions_for_account(account))},
           "start": "2026-07-01", "end": "2026-07-14"}

    simulated = alerts.budget_alerts._simulate_after(ctx, [posted, resend], repo)  # posted FIRST
    repo.insert_or_reconcile([posted, resend])

    stored = list(repo._table.store.values())
    assert sorted(r["transaction_id"] for r in simulated) == sorted(r["transaction_id"] for r in stored)
    assert [r["transaction_id"] for r in stored] == ["POST"]

# --- Single-word merchants in the alert preview (QA) --------------------------
# Asserting only "no push fired" passes for the wrong reason if the preview and the
# real write BOTH stop counting the charge. These compare the preview to the ledger.

_COLES_ALERT_PEND_DESC = "POS AUTHORISATION         COLES 0602               MELBOURNE    AU"


def _coles_alert_rows(*, pend_date="2026-07-11", post_auth="2026-07-10",
                      post_date="2026-07-14", amount=Decimal("-70")):
    pending = _bank("PEND", amount, pending=True, category="groceries", date=pend_date,
                    authorized_date=pend_date, merchant_name="",
                    description=_COLES_ALERT_PEND_DESC)
    posted = _bank("POST", amount, pending=False, category="groceries",
                   date=post_date, authorized_date=post_auth,
                   description="COLES 0602 MELBOURNE",
                   merchant_name="COLES 0602               ")
    return pending, posted


def test_one_word_skew_simulation_matches_the_real_write(alerts, repo):
    pending_row, posted_row = _coles_alert_rows()
    repo.insert_transactions([alerts.banksync.BankSyncClient.normalise(pending_row)])
    before = list(repo._table.store.values())
    account = before[0]["account_id"]
    posted = alerts.banksync.BankSyncClient.normalise(posted_row)
    ctx = {"before_rows": before,
           "pending_pools": {account: list(repo.get_pending_transactions_for_account(account))},
           "start": "2026-07-01", "end": "2026-07-14"}

    simulated = alerts.budget_alerts._simulate_after(ctx, [posted], repo)
    repo.insert_or_reconcile([posted])

    stored = list(repo._table.store.values())
    assert sorted(r["transaction_id"] for r in simulated) == sorted(r["transaction_id"] for r in stored)
    assert [r["transaction_id"] for r in stored] == ["POST"]
    # The preview must agree on the DATE too — the cycle window filters on it.
    assert [r["date"] for r in simulated] == ["2026-07-11"]
    assert stored[0]["date"] == "2026-07-11"


def test_one_word_skew_across_the_cycle_boundary_counts_once_inside_the_window(alerts, repo, monkeypatch):
    # Pending on the first day of the cycle, its twin's UTC date on the last day of the
    # previous one. A preview that kept the UTC date would drop the charge out of the
    # window entirely and under-count.
    pending_row, posted_row = _coles_alert_rows(pend_date="2026-07-01",
                                                post_auth="2026-06-30", post_date="2026-07-03")
    repo.insert_transactions([alerts.banksync.BankSyncClient.normalise(pending_row)])
    before = list(repo._table.store.values())
    posted = alerts.banksync.BankSyncClient.normalise(posted_row)

    sent, notify, ctx = _run(alerts, monkeypatch,
                             budgets={"groceries": {"target": Decimal("100")}},
                             before=before, normalised=[posted], webhook_repo=repo)
    rows = alerts.budget_alerts._simulate_after(ctx, [posted], repo)

    assert [(r["transaction_id"], r["date"]) for r in rows] == [("POST", "2026-07-01")]
    assert sent == []
    assert notify.fired_markers("2026-07-01", 14) == set()


# ===========================================================================
# WHIT-343 QA GAP tests (aggregate-then-clamp on the ALERT path) — edges beyond
# the implementer's test_parent_fold_aggregates_then_clamps_refund_offsets_sibling
# and test_combined_target_clamps_each_bucket_after_aggregating. Every WHIT-343
# assertion goes RED if the per-id clamp is restored; the bucket-guard assertion
# goes RED if the same-bucket filter is dropped.
# ===========================================================================


def test_wh343_gap_refund_suppresses_crossing_regardless_of_batch_order(alerts, monkeypatch):
    # WHIT-343 x ordering. A refund and a charge on two leaves of the same parent, in the
    # SAME write, must net the parent the SAME way no matter their order — no refund-then-
    # charge sequencing can slip a crossing. before empty. Batch parking -90 (would be 90%)
    # + fuel +30 refund -> car 60 < 80 -> SILENT in BOTH orders. Fail-on-revert (per-id
    # clamp): fuel floors to 0 -> car 90 -> FIRES. Control (no refund) crosses, proving the
    # setup genuinely would fire.
    for batch in (
        [_txn("c", "parking", -90, "posted"), _txn("r", "fuel", 30, "posted")],
        [_txn("r", "fuel", 30, "posted"), _txn("c", "parking", -90, "posted")],  # reversed
    ):
        sent, notify, _ = _run(alerts, monkeypatch, budgets={"car": {"target": Decimal("100")}},
                               before=[], normalised=batch, cats=_CAR_TREE)
        assert sent == []
        assert notify.fired_markers("2026-07-01", 14) == set()

    control, _, _ = _run(alerts, monkeypatch, budgets={"car": {"target": Decimal("100")}},
                         before=[], normalised=[_txn("c", "parking", -90, "posted")], cats=_CAR_TREE)
    assert len(control) == 1 and control[0][1] == "Car is at 80% of its budget this cycle."


def test_wh343_gap_grandchild_refund_nets_across_deep_fold_suppresses(alerts, monkeypatch):
    # WHIT-343 x depth on the alert path. car -> daily -> {petrol, tolls}; only car budgeted.
    # before petrol -75 (car 75). Batch: petrol -20 (would push car to 95, crossing 80) +
    # tolls +30 refund on the sibling GRANDCHILD -> car 95 - 30 = 65 < 80 -> SILENT.
    # Fail-on-revert (per-id clamp): tolls +30 floors to 0 -> car 95 -> FIRES at 80.
    cats = [
        {"id": "car", "name": "Car", "bucket": "Living", "parent": None},
        {"id": "daily", "name": "Daily", "bucket": "Living", "parent": "car"},
        {"id": "petrol", "name": "Petrol", "bucket": "Living", "parent": "daily"},
        {"id": "tolls", "name": "Tolls", "bucket": "Living", "parent": "daily"},
    ]
    before = [_txn("old", "petrol", -75, "posted")]
    batch = [_txn("p", "petrol", -20, "posted"), _txn("r", "tolls", 30, "posted")]
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"car": {"target": Decimal("100")}},
                           before=before, normalised=batch, cats=cats)
    assert sent == []
    assert notify.fired_markers("2026-07-01", 14) == set()

    control, _, _ = _run(alerts, monkeypatch, budgets={"car": {"target": Decimal("100")}},
                         before=before, normalised=[_txn("p", "petrol", -20, "posted")], cats=cats)
    assert len(control) == 1 and control[0][1] == "Car is at 80% of its budget this cycle."


def test_wh343_gap_cross_bucket_refund_sibling_does_not_suppress_real_crossing(alerts, monkeypatch):
    # WHIT-343 x the same-bucket guard. A REFUND on a cross-bucket sibling must NOT net a
    # genuine same-bucket crossing away: the guard drops it from the parent's subtree BEFORE
    # the unclamped fold, so it can't offset. petrol -85 (85% of Car) crosses 80; a +50
    # refund on a Lifestyle child would net Car to 35 and SILENCE it IF it leaked. Correct:
    # excluded -> Car 85 -> FIRES. Fail-on-revert (drop bucket_by_id): Car 35 -> silent.
    cats = [
        {"id": "car", "name": "Car", "bucket": "Living", "parent": None},
        {"id": "petrol", "name": "Petrol", "bucket": "Living", "parent": "car"},
        {"id": "odd", "name": "Odd", "bucket": "Lifestyle", "parent": "car"},
    ]
    batch = [_txn("p", "petrol", -85, "posted"), _txn("r", "odd", 50, "posted")]  # cross-bucket refund
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"car": {"target": Decimal("100")}},
                           before=[], normalised=batch, cats=cats)
    assert len(sent) == 1
    assert sent[0][1] == "Car is at 80% of its budget this cycle."
    assert notify.fired_markers("2026-07-01", 14) == {"car#80"}


def test_wh343_gap_tip_settlement_crossing_cancelled_by_sibling_refund(alerts, repo, monkeypatch):
    # WHIT-343 x reconcile. A pending leaf settles with a TIP that alone crosses the parent,
    # while a refund on a sibling leaf in the SAME write nets it back below — the settlement
    # Delta (real reconcile) AND the aggregate-then-clamp both have to be right. Pending
    # parking -70 (car 70). Batch: posted -85 tip settlement carrying "parking" (twin removed,
    # car -> 85, crosses 80) + fuel +30 refund -> car 85 - 30 = 55 < 80 -> SILENT.
    # Fail-on-revert (per-id clamp): fuel +30 floors to 0 -> car 85 -> a false car#80.
    _seed(repo, alerts, txn_id="A", amount=Decimal("-70"), pending=True, category="parking")
    before = list(repo._table.store.values())
    posted = _norm_real(alerts, txn_id="B", amount=Decimal("-85"), pending=False, category="parking",
                        merchant_name="SQ *KKV INTERNATIONAL PTY", description="SQ *KKV INTERNATIONAL PTY")
    refund = _norm_real(alerts, txn_id="R", amount=Decimal("30"), pending=False, category="fuel",
                        merchant_name="REFUNDCO PTY", description="REFUNDCO PTY")
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"car": {"target": Decimal("100")}},
                           before=before, normalised=[posted, refund], webhook_repo=repo, cats=_CAR_TREE)
    assert sent == []
    assert notify.fired_markers("2026-07-01", 14) == set()

    # Control: WITHOUT the refund, the tip settlement genuinely crosses 80 -> proves the
    # setup would fire and that the refund (not a broken settlement) is what silences it.
    ctrl_posted = _norm_real(alerts, txn_id="B", amount=Decimal("-85"), pending=False, category="parking",
                             merchant_name="SQ *KKV INTERNATIONAL PTY", description="SQ *KKV INTERNATIONAL PTY")
    control, _, _ = _run(alerts, monkeypatch, budgets={"car": {"target": Decimal("100")}},
                         before=list(repo._table.store.values()), normalised=[ctrl_posted],
                         webhook_repo=repo, cats=_CAR_TREE)
    assert len(control) == 1 and control[0][1] == "Car is at 80% of its budget this cycle."


# ======================================================================================
# Folded from per-ticket budget-alert satellites (WHIT-452 Slice 1). Bodies moved
# verbatim; budget_296's copy of the fake repos / alerts fixture / NoTwinRepo was dropped
# in favour of this file's harness above.
# ======================================================================================


# --- WHIT-350: the _combined_target wrapper (posted + pending, Decimal) ---------------
# (was test_budget_alerts_fold_gaps.py) Pure function; the `lam` fixture only makes
# shared/ (spend + budget_alerts) importable exactly as the sibling tests do.


def test_combined_target_adds_posted_and_pending_both_nonzero(lam):
    # [A_CT_ADD] (P0) posted nets +40 (petrol -60 spend, tolls +20 refund) and pending
    # nets +15 (a separate pending leg), each survives its independent clamp, so the alert
    # combined target = 40 + 15 = 55 — the SAME figure /budgets' posted+pending shows for
    # this subtree. The clamps-to-0 test never exercises this addition. [fail-on-revert]
    # a wrapper returning only folded["posted"] gives 40; a per-id clamp gives 60+0.
    import spend, budget_alerts
    ids = {"car", "petrol", "tolls"}
    per_id = spend.summarise_transactions([
        {"transaction_id": "a", "account_id": "up-spending", "category": "petrol",
         "amount": Decimal("-60"), "status": "posted", "date": "2026-07-10",
         "counts_to_budget": True},
        {"transaction_id": "b", "account_id": "up-spending", "category": "tolls",
         "amount": Decimal("20"), "status": "posted", "date": "2026-07-10",
         "counts_to_budget": True},
        {"transaction_id": "c", "account_id": "up-spending", "category": "petrol",
         "amount": Decimal("-15"), "status": "pending", "date": "2026-07-10",
         "counts_to_budget": True},
    ], ids, clamp=False)
    assert budget_alerts._combined_target(per_id, ids) == Decimal("55")


def test_combined_target_negative_posted_does_not_drag_pending(lam):
    # [A_CT_INDEP] (P0) posted nets NEGATIVE (-30, floored to 0) while pending nets +25.
    # Independent clamp: the negative posted must not cancel the pending. Combined = 0 + 25.
    # [fail-on-revert] clamping the COMBINED sum (max(0, -30+25)) would give 0, not 25.
    import spend, budget_alerts
    ids = {"car", "petrol"}
    per_id = spend.summarise_transactions([
        {"transaction_id": "a", "account_id": "up-spending", "category": "petrol",
         "amount": Decimal("-10"), "status": "posted", "date": "2026-07-10",
         "counts_to_budget": True},
        {"transaction_id": "b", "account_id": "up-spending", "category": "petrol",
         "amount": Decimal("40"), "status": "posted", "date": "2026-07-10",
         "counts_to_budget": True},   # posted nets -30 -> floor 0
        {"transaction_id": "c", "account_id": "up-spending", "category": "petrol",
         "amount": Decimal("-25"), "status": "pending", "date": "2026-07-10",
         "counts_to_budget": True},   # pending nets +25, must survive
    ], ids, clamp=False)
    assert budget_alerts._combined_target(per_id, ids) == Decimal("25")


def test_combined_target_empty_ids_returns_decimal_not_int(lam):
    # [A_CT_EMPTY] (P1) A corrupt/empty subtree must yield a Decimal, not int — the named
    # docstring contract ("Seed Decimal(0) so an empty set yields Decimal, not int"). The
    # implementer's == 0 check passes for int 0 too, so the TYPE was never locked.
    # [fail-on-revert] a fold seeded with int 0 + max(0, ...) would return int 0 here.
    import budget_alerts
    result = budget_alerts._combined_target({"a": {"posted": Decimal("9"), "pending": Decimal("3")}}, set())
    assert result == Decimal("0")
    assert isinstance(result, Decimal)


def test_combined_target_net_zero_present_entry_contributes_zero_decimal(lam):
    # [A_CT_ZERODICT] (P2) With clamp=False a category can net to {posted:0, pending:0}
    # (a refund exactly cancels its spend) and still be PRESENT in per_id. fold_subtree must
    # treat that present-zero entry the same as absence: 0, and the result stays Decimal.
    import spend, budget_alerts
    ids = {"car", "petrol"}
    per_id = spend.summarise_transactions([
        {"transaction_id": "a", "account_id": "up-spending", "category": "petrol",
         "amount": Decimal("-30"), "status": "posted", "date": "2026-07-10",
         "counts_to_budget": True},
        {"transaction_id": "b", "account_id": "up-spending", "category": "petrol",
         "amount": Decimal("30"), "status": "posted", "date": "2026-07-10",
         "counts_to_budget": True},   # exactly cancels -> present entry {0, 0}
    ], ids, clamp=False)
    assert per_id["petrol"] == {"posted": Decimal("0"), "pending": Decimal("0")}  # precondition
    result = budget_alerts._combined_target(per_id, ids)
    assert result == Decimal("0")
    assert isinstance(result, Decimal)


# --- WHIT-296: the over-budget push honours the budget_excluded override --------------
# (was test_budget_alerts_whit296.py) Reuses this file's fake repos + NoTwinRepo above.
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


def test_excluded_charge_in_batch_never_crosses_threshold(alerts, monkeypatch):
    # [A-P2] The gate alone: a lone excluded groceries -85 in the batch (no twin) must
    # not push. Fail-on-revert: revert the spend gate and the 80% push fires.
    posted = _posted("g1", "groceries", -85, budget_excluded=True)

    sent, _, _ = _run(alerts, monkeypatch,
                      budgets={"groceries": {"target": Decimal("100")}},
                      before=[], normalised=[posted], webhook_repo=NoTwinRepo())

    assert sent == []


# ── WHIT-509: the alert threshold folds in the bill-spread cushion ──────────────
#
# The /budgets screen spends against target + the signed spread adjustment (WHIT-504):
# a full +amount cushion in the cycle the bill lands, an equal slice taken back over the
# next N cycles. Before this fix the push path crossed against the RAW target only, so a
# cushioned category that the screen shows as in-budget could still fire a false "over
# budget" push. fire_budget_alerts now crosses against `target + adjustment`, computed with
# the SAME shared._spread_state + same args as list_budgets, so the two can't disagree.
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


def test_spread_real_overspend_past_the_cushion_still_fires(alerts, monkeypatch):
    # (b) Same $300 basis, but real spend $230 → $310 clears the cushion and crosses 100%
    # of the basis → "Budget hit" fires. Revert to the raw target and $230 is already past
    # both thresholds, so nothing is newly crossed → no push: so the push proves the fix.
    budget = {"target": Decimal("100"), **_spread_fields(200, 4)}
    before = [_txn("old", "groceries", -230, "posted")]
    new = _txn("new1", "groceries", -80, "posted")
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"groceries": budget},
                           before=before, normalised=[new], cats=_SPREAD_CATS)
    assert len(sent) == 1
    title, body, _toks = sent[0]
    assert title == "Budget hit"
    assert body == "You've spent your whole Groceries budget for this cycle."
    assert notify.fired_markers("2026-07-01", 14) == {"groceries#100", "groceries#80"}


def test_spread_eighty_percent_heads_up_uses_the_cushioned_basis(alerts, monkeypatch):
    # (c) The 80% heads-up also moves with the cushion: $300 basis, $200 → $250 crosses 80%
    # of $300 ($240) but not 100% → "Heads up". Revert to raw target and $200 is already
    # past both → no push, so the heads-up proves the cushion lifted the 80% mark too.
    budget = {"target": Decimal("100"), **_spread_fields(200, 4)}
    before = [_txn("old", "groceries", -200, "posted")]
    new = _txn("new1", "groceries", -50, "posted")
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"groceries": budget},
                           before=before, normalised=[new], cats=_SPREAD_CATS)
    assert len(sent) == 1
    title, body, _toks = sent[0]
    assert title == "Heads up \U0001f440"
    assert body == "Groceries is at 80% of its budget this cycle."
    assert notify.fired_markers("2026-07-01", 14) == {"groceries#80"}


def test_spread_payback_cycle_lowers_basis_and_fires_earlier(alerts, monkeypatch):
    # (d) A payback cycle (index 1: spread_from one cycle back) takes a -$50 slice, so a
    # $100 target drops to a $50 basis. Just $30 → $55 of spend crosses 100% of the $50
    # basis → "Budget hit" at a spend the raw target ($100) would never flag. Revert and
    # $55 is below both raw thresholds → no push.
    budget = {"target": Decimal("100"), **_spread_fields(200, 4, spread_from="2026-06-17")}
    before = [_txn("old", "groceries", -30, "posted")]
    new = _txn("new1", "groceries", -25, "posted")
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"groceries": budget},
                           before=before, normalised=[new], cats=_SPREAD_CATS)
    assert len(sent) == 1
    assert sent[0][0] == "Budget hit"
    assert notify.fired_markers("2026-07-01", 14) == {"groceries#100", "groceries#80"}


def test_spread_misaligned_plan_uses_the_settled_adjustment_without_persisting(alerts, monkeypatch):
    # (e) A pay-cycle change left the plan MISALIGNED (spread_paydate 2026-06-20 ≠ the
    # current 2026-07-01). The alert must settle it EXACTLY as the read path does — settle
    # → a 1-cycle plan of the $100 outstanding → a -$100 adjustment → a $200 basis on the
    # $300 target — and must NOT persist anything (the /budgets read owns persistence).
    import spend
    budget = {"target": Decimal("300"),
              **_spread_fields(200, 4, spread_from="2026-06-01", spread_paydate="2026-06-20")}

    # Pin the read-path computation so this test fails if the shared helper's settle maths
    # drifts: the alert MUST use exactly this adjustment.
    row, finished, reanchor = spend._spread_state(
        budget, "2026-07-01", 14, "2026-07-01", "2026-07-14")
    assert row["adjustment"] == Decimal("-100")  # basis = 300 + (-100) = 200
    assert reanchor is not None and not finished   # it settled, it did not just clear

    before = [_txn("old", "groceries", -150, "posted")]
    new = _txn("new1", "groceries", -60, "posted")
    budgets = {"groceries": budget}
    sent, notify, _ = _run(alerts, monkeypatch, budgets=budgets,
                           before=before, normalised=[new], cats=_SPREAD_CATS)
    # $150 → $210 crosses 100% of the $200 basis. Revert to the raw $300 target and
    # 0.8*300=240 > 210 → nothing crosses → no push: the push proves the settled basis.
    assert len(sent) == 1
    assert sent[0][0] == "Budget hit"
    # No persistence from the alert path: FakeBudgetRepo has no write method, so a settle
    # write would have raised. The stored entry is still the untouched misaligned plan.
    assert budgets["groceries"]["spread_paydate"] == "2026-06-20"
    assert budgets["groceries"]["spread_amount"] == Decimal("200")


def test_plain_budget_is_unaffected_by_the_cushion_change(alerts, monkeypatch):
    # (f) Regression: a budget with NO spread fields takes the exact pre-change path — the
    # `"spread_amount" in entry` gate leaves it on the raw target. $70 → $85 crosses 80% of
    # $100, byte-identical to test_crossing_fires_via_delta_not_a_reread.
    before = [_txn("old", "groceries", -70, "posted")]
    new = _txn("new1", "groceries", -15, "posted")
    sent, notify, _ = _run(alerts, monkeypatch,
                           budgets={"groceries": {"target": Decimal("100")}},
                           before=before, normalised=[new], cats=_SPREAD_CATS)
    assert len(sent) == 1
    assert sent[0][1] == "Groceries is at 80% of its budget this cycle."
    assert notify.fired_markers("2026-07-01", 14) == {"groceries#80"}


def test_stale_spread_on_a_rebucketed_savings_category_never_pushes(alerts, monkeypatch):
    # (g) Guard (not fail-on-revert): the clear-on-reclassify is best-effort, so a Savings
    # category can still carry stale spread_* fields. The Savings bucket filter drops it
    # before any cushion maths, so a big overspend sends NOTHING — the stale cushion can't
    # resurrect an alert on a floor category (mirrors WHIT-201's read-path guard).
    budget = {"target": Decimal("100"), **_spread_fields(200, 4)}
    cats = [{"id": "groceries", "name": "Groceries", "bucket": "Savings"}]
    before = [_txn("old", "groceries", -50, "posted")]
    new = _txn("new1", "groceries", -80, "posted")
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"groceries": budget},
                           before=before, normalised=[new], cats=cats)
    assert sent == []
    assert notify.fired_markers("2026-07-01", 14) == set()


# ── WHIT-509 (qa gaps): spread-cushion interactions the acceptance 7 miss ────────
# Appended by QA. Reuses _run / _txn / FakeBudgetRepo / _SPREAD_CATS / _spread_fields
# and the pinned cycle (start 2026-07-01, len 14, today 2026-07-14). Every
# fail-on-revert test below was proven RED when `basis` is reverted to `target`.


def test_spread_debounce_escalates_to_100_even_with_80_already_fired(alerts, monkeypatch):
    # [A-qa1] (P0) Debounce + cushion interaction. 80% already marked this cycle; a new
    # write crosses 100% of the CUSHIONED basis ($300). The debounce must not block the
    # higher threshold, and the 100% crossing must be measured against target+adjustment.
    # before $245 (past 80% of 300=240, below 100%=300) → after $305 crosses 100% → fires
    # "Budget hit" + writes groceries#100 (groceries#80 already present).
    # Fail-on-revert (basis→target): before $245 is already past 100% of the raw $100, so
    # `newly` is empty → NO push. The push proves the cushion governs the escalation.
    notify = FakeNotifyRepo()
    notify.mark_fired("2026-07-01", 14, "groceries#80")
    budget = {"target": Decimal("100"), **_spread_fields(200, 4)}
    before = [_txn("old", "groceries", -245, "posted")]
    new = _txn("new1", "groceries", -60, "posted")
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"groceries": budget},
                           before=before, normalised=[new], notify=notify, cats=_SPREAD_CATS)
    assert len(sent) == 1
    assert sent[0][0] == "Budget hit"
    assert notify.fired_markers("2026-07-01", 14) == {"groceries#80", "groceries#100"}


def test_spread_debounce_suppresses_a_repeat_80_within_the_same_cycle(alerts, monkeypatch):
    # [A-qa2] (P1) The cushioned 80% fired once; a later write that re-crosses 80% of the
    # same $300 basis (but not 100%) is debounced → silent. Guards that the cushion path
    # still honours the per-(cat,threshold) marker rather than re-alerting every ingest.
    notify = FakeNotifyRepo()
    notify.mark_fired("2026-07-01", 14, "groceries#80")
    budget = {"target": Decimal("100"), **_spread_fields(200, 4)}
    before = [_txn("old", "groceries", -239, "posted")]   # just under 80% of 300
    new = _txn("new1", "groceries", -5, "posted")          # → 244, re-crosses 80% of 300
    sent, _, _ = _run(alerts, monkeypatch, budgets={"groceries": budget},
                      before=before, normalised=[new], notify=notify, cats=_SPREAD_CATS)
    assert sent == []


def test_spread_cushion_on_a_budgeted_parent_folds_child_spend(alerts, monkeypatch):
    # [A-qa3] (P0) The cushion lives on a ROLLED-UP PARENT budget; spend is tagged on a
    # budgeted-less CHILD. The parent's basis = target + adjustment ($300) and its combined
    # spend is the subtree fold (parent + child). Child spend $200 → $250 crosses 80% of
    # $300 (=240) → fires "food#80". Proves the cushion is read off the parent entry AND
    # applied to the subtree total.
    # Fail-on-revert (basis→target): $200 already past the raw $100 → nothing newly crossed
    # → no push.
    cats = [
        {"id": "food", "name": "Food", "bucket": "Living"},
        {"id": "groceries", "name": "Groceries", "bucket": "Living", "parent": "food"},
    ]
    budget = {"target": Decimal("100"), **_spread_fields(200, 4)}
    before = [_txn("old", "groceries", -200, "posted")]   # spend on the CHILD
    new = _txn("new1", "groceries", -50, "posted")
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"food": budget},
                           before=before, normalised=[new], cats=cats)
    assert len(sent) == 1
    assert sent[0][0] == "Heads up \U0001f440"
    assert sent[0][1] == "Food is at 80% of its budget this cycle."
    assert notify.fired_markers("2026-07-01", 14) == {"food#80"}


def test_spread_basis_at_uneven_cent_slice_crosses_exactly(alerts, monkeypatch):
    # [A-qa4] (P0) Uneven-cents slicing: $200 over 6 cycles, index 1 → the first `extra`=2
    # slices carry one extra cent, so the slice is 33.34 (not 33.33) → basis = 100 − 33.34
    # = $66.66. A write landing exactly on $66.66 must cross 100% (b < basis <= a with
    # basis=66.66). If the slice were mis-split to 33.33 the basis would be 66.67 and this
    # would NOT fire — so this locks the extra-cent carry feeding the alert basis.
    # Fail-on-revert (basis→target): $66.66 crosses nothing of the raw $100 → no push.
    budget = {"target": Decimal("100"), **_spread_fields(200, 6, spread_from="2026-06-17")}
    before = [_txn("old", "groceries", "-66.65", "posted")]
    new = _txn("new1", "groceries", "-0.01", "posted")     # → 66.66 exactly
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"groceries": budget},
                           before=before, normalised=[new], cats=_SPREAD_CATS)
    assert len(sent) == 1
    assert sent[0][0] == "Budget hit"                      # 100% of the 66.66 basis
    # Both thresholds are reached; the 100% push goes out and the 80% one is marked with it.
    assert notify.fired_markers("2026-07-01", 14) == {"groceries#100", "groceries#80"}


def test_spread_basis_at_uneven_cent_slice_one_cent_below_does_not_fire(alerts, monkeypatch):
    # [A-qa5] (P1) Complement of A-qa4: $66.65 (one cent below the $66.66 basis) must NOT
    # cross 100%. Pins that the basis is exactly 66.66 — not rounded down to 66.65 — so the
    # inclusive `<= basis` edge sits on the right cent.
    budget = {"target": Decimal("100"), **_spread_fields(200, 6, spread_from="2026-06-17")}
    before = [_txn("old", "groceries", "-66.64", "posted")]
    new = _txn("new1", "groceries", "-0.01", "posted")     # → 66.65, still < 66.66
    notify = FakeNotifyRepo()
    notify.mark_fired("2026-07-01", 14, "groceries#80")   # the 80% heads-up already went out
    sent, _, _ = _run(alerts, monkeypatch, budgets={"groceries": budget},
                      before=before, normalised=[new], cats=_SPREAD_CATS, notify=notify)
    assert sent == []


def test_spread_index_past_cycles_behaves_like_a_plain_budget(alerts, monkeypatch):
    # [A-qa6] (P1, guard) A spread whose index has run PAST its cycles (index 5 > 4 cycles)
    # → _spread_state returns None → adjustment 0 → basis == target. It must behave exactly
    # like a plain $100 budget: $70 → $85 crosses 80% of $100. Guards that a finished spread
    # leaves NO stale cushion on the alert basis (a spread-helper regression would inflate
    # the basis and silence this). Not fail-on-revert (basis already == target here).
    import spend
    budget = {"target": Decimal("100"), **_spread_fields(200, 4, spread_from="2026-04-22")}
    row, _finished, _reanchor = spend._spread_state(budget, "2026-07-01", 14, "2026-07-01", "2026-07-14")
    assert row is None                                     # past cycles → nothing to show
    before = [_txn("old", "groceries", -70, "posted")]
    new = _txn("new1", "groceries", -15, "posted")
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"groceries": budget},
                           before=before, normalised=[new], cats=_SPREAD_CATS)
    assert len(sent) == 1
    assert sent[0][1] == "Groceries is at 80% of its budget this cycle."
    assert notify.fired_markers("2026-07-01", 14) == {"groceries#80"}


def test_spread_pending_plus_posted_mix_crosses_the_cushioned_basis(alerts, monkeypatch):
    # [A-qa7] (P0) Combined spend = posted + pending, measured against the cushioned basis.
    # $300 basis; one batch of posted -$150 AND pending -$100 → combined $250 crosses 80% of
    # $300 (=240) → fires "Heads up". Proves a pending authorisation counts toward the
    # cushioned basis just as posted does.
    # Fail-on-revert (basis→target): $250 is already past the raw $100 → nothing newly
    # crossed → no push.
    budget = {"target": Decimal("100"), **_spread_fields(200, 4)}
    posted = _txn("p1", "groceries", -150, "posted")
    pending = _txn("pend1", "groceries", -100, "pending")
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"groceries": budget},
                           before=[], normalised=[posted, pending], cats=_SPREAD_CATS)
    assert len(sent) == 1
    assert sent[0][0] == "Heads up \U0001f440"
    assert notify.fired_markers("2026-07-01", 14) == {"groceries#80"}


def test_spread_on_one_category_does_not_cushion_a_co_batched_plain_budget(alerts, monkeypatch):
    # [A-qa8] (P0) Two budgeted categories in ONE write: groceries carries a spread (basis
    # $300), coffee is plain (target $50, no spread fields). groceries $70 → $120 stays
    # under 80% of $300 (=240) → silent; coffee $35 → $45 crosses 80% of $50 (=40) → fires.
    # Exactly ONE push (coffee). Proves the cushion is applied per-entry — a spread on one
    # category must not alter another's raw-target basis.
    # Fail-on-revert (basis→target): groceries' $70→$120 newly crosses the raw $100 → a
    # SECOND ("Budget hit") push appears for groceries. ($120 stays < 80% of the $300 basis.)
    cats = [
        {"id": "groceries", "name": "Groceries", "bucket": "Living"},
        {"id": "coffee", "name": "Coffee", "bucket": "Living"},
    ]
    budgets = {
        "groceries": {"target": Decimal("100"), **_spread_fields(200, 4)},
        "coffee": {"target": Decimal("50")},
    }
    before = [_txn("g", "groceries", -70, "posted"), _txn("c", "coffee", -35, "posted")]
    batch = [_txn("g2", "groceries", -50, "posted"), _txn("c2", "coffee", -10, "posted")]
    sent, notify, _ = _run(alerts, monkeypatch, budgets=budgets,
                           before=before, normalised=batch, cats=cats)
    assert len(sent) == 1
    assert sent[0][1] == "Coffee is at 80% of its budget this cycle."
    assert notify.fired_markers("2026-07-01", 14) == {"coffee#80"}


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


def test_spread_basis_just_above_zero_still_crosses(alerts, monkeypatch):
    # [A-qa10] (P0) The complement of the basis==0 skip: basis just ABOVE zero ($0.01) must
    # NOT be skipped. target 100, $199.98 over 2 cycles, index 1 → −$99.99 slice → basis
    # $0.01. A single −$0.01 posting lands combined $0.01 → crosses 100% of $0.01 → fires.
    # Proves the guard is `<= 0`, not `< small-epsilon`, and that a cent-sized basis still
    # alerts honestly.
    # Fail-on-revert (basis→target): $0.01 crosses nothing of the raw $100 → no push.
    budget = {"target": Decimal("100"), **_spread_fields("199.98", 2, spread_from="2026-06-17")}
    new = _txn("new1", "groceries", "-0.01", "posted")
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"groceries": budget},
                           before=[], normalised=[new], cats=_SPREAD_CATS)
    assert len(sent) == 1
    assert sent[0][0] == "Budget hit"
    assert notify.fired_markers("2026-07-01", 14) == {"groceries#80", "groceries#100"}


# --- WHIT-555: rollover live buffer is folded INTO the alert basis ---------------------
# The /budgets screen's spendable = target + live rollover buffer. The alert must agree:
# `basis = target + buffer`, so a category with leftover from prior cycles has a higher
# crossing threshold (the user sees more room), and one with a deficit has a lower one.


def test_rollover_sealed_buffer_raises_basis_and_suppresses_premature_80(alerts, monkeypatch):
    # $100 target with $50 sealed carryover → basis = 150, 80% = $120.
    # Before $70, +$15 → $85. $85 < $120 → NO push (the user still has room per the screen).
    # Fail-on-revert: without the buffer, basis = 100, 80% = $80, $85 crosses → false push
    # that contradicts the screen.
    budget = {
        "target": Decimal("100"), "rollover": True, "carryover": Decimal("50"),
        "carryover_from": "2026-07-01",
        "carryover_len": Decimal("14"), "carryover_paydate": "2026-07-01",
    }
    before = [_txn("old", "groceries", -70, "posted")]
    new = _txn("new1", "groceries", -15, "posted")
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"groceries": budget},
                           before=before, normalised=[new], cats=_SPREAD_CATS)
    assert len(sent) == 0
    assert notify.fired_markers("2026-07-01", 14) == set()


def test_rollover_sealed_buffer_fires_when_spend_crosses_raised_80(alerts, monkeypatch):
    # $100 target + $50 buffer → basis = 150, 80% = $120.
    # Before $110, +$15 → $125 crosses $120 → fires 80%.
    budget = {
        "target": Decimal("100"), "rollover": True, "carryover": Decimal("50"),
        "carryover_from": "2026-07-01",
        "carryover_len": Decimal("14"), "carryover_paydate": "2026-07-01",
    }
    before = [_txn("old", "groceries", -110, "posted")]
    new = _txn("new1", "groceries", -15, "posted")
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"groceries": budget},
                           before=before, normalised=[new], cats=_SPREAD_CATS)
    assert len(sent) == 1
    assert "80%" in sent[0][1]
    assert notify.fired_markers("2026-07-01", 14) == {"groceries#80"}


def test_rollover_negative_buffer_lowers_basis(alerts, monkeypatch):
    # $100 target with -$30 carryover (overspent last cycle) → basis = 70, 80% = $56.
    # Before $50, +$10 → $60 crosses $56 → fires 80%.
    # Fail-on-revert: without the buffer, basis = 100, 80% = $80, $60 never crosses → miss.
    budget = {
        "target": Decimal("100"), "rollover": True, "carryover": Decimal("-30"),
        "carryover_from": "2026-07-01",
        "carryover_len": Decimal("14"), "carryover_paydate": "2026-07-01",
    }
    before = [_txn("old", "groceries", -50, "posted")]
    new = _txn("new1", "groceries", -10, "posted")
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"groceries": budget},
                           before=before, normalised=[new], cats=_SPREAD_CATS)
    assert len(sent) == 1
    assert "80%" in sent[0][1]


def test_rollover_wins_over_spread_on_corrupt_entry(alerts, monkeypatch):
    # A corrupt entry has BOTH rollover and spread. Rollover wins: buffer_term = carryover,
    # spread adjustment is ignored. basis = 100 + 50 = 150, 80% = $120.
    # Before $0, +$45 → $45. $45 < $120 → NO push.
    # Fail-on-revert: without buffer fold, basis = 100 (old code ignores rollover),
    # and the spread -50 payback makes basis = 50, 80% = $40. 0 < 40 <= 45 → fires a push.
    budget = {
        "target": Decimal("100"), "rollover": True, "carryover": Decimal("50"),
        "carryover_from": "2026-07-01",
        "carryover_len": Decimal("14"), "carryover_paydate": "2026-07-01",
        "spread_amount": Decimal("200"), "spread_cycles": Decimal("4"),
        "spread_from": "2026-06-17", "spread_len": Decimal("14"),
        "spread_paydate": "2026-07-01",
    }
    before = []
    new = _txn("new1", "groceries", -45, "posted")
    sent, _, _ = _run(alerts, monkeypatch, budgets={"groceries": budget},
                      before=before, normalised=[new], cats=_SPREAD_CATS)
    assert len(sent) == 0


def test_rollover_reanchor_uses_stored_carryover_as_buffer(alerts, monkeypatch):
    # Misaligned anchor (different length) → reanchor path. The stored carryover ($40) is
    # still used as buffer_term. basis = 100 + 40 = 140, 80% = $112.
    # Before $105, +$10 → $115 crosses $112 → fires 80%.
    budget = {
        "target": Decimal("100"), "rollover": True, "carryover": Decimal("40"),
        "carryover_from": "2026-06-15",
        "carryover_len": Decimal("7"), "carryover_paydate": "2026-07-01",
    }
    before = [_txn("old", "groceries", -105, "posted")]
    new = _txn("new1", "groceries", -10, "posted")
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"groceries": budget},
                           before=before, normalised=[new], cats=_SPREAD_CATS)
    assert len(sent) == 1
    assert "80%" in sent[0][1]


def test_rollover_buffer_folds_live_from_prior_cycle_txns(alerts, monkeypatch):
    # One completed cycle [2026-06-17, 2026-06-30] with $60 spend on a $100 target → leftover $40.
    # Stored carryover = $0, so live buffer = 0 + 40 = $40. basis = 100 + 40 = 140, 80% = $112.
    # Current-cycle spend before $105, +$10 → $115 crosses $112 → fires.
    # Fail-on-revert: without live seal, buffer = 0, basis = 100, 80% = $80, $105 already past → miss.
    budget = {
        "target": Decimal("100"), "rollover": True, "carryover": Decimal("0"),
        "carryover_from": "2026-06-17",
        "carryover_len": Decimal("14"), "carryover_paydate": "2026-07-01",
    }
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


def test_non_rollover_budget_unaffected_by_rollover_logic(alerts, monkeypatch):
    # A plain budget (no rollover, no spread): basis = target only, exactly as before.
    before = [_txn("old", "groceries", -70, "posted")]
    new = _txn("new1", "groceries", -15, "posted")
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("100")}},
                           before=before, normalised=[new], cats=_SPREAD_CATS)
    assert len(sent) == 1
    assert "80%" in sent[0][1]
    assert notify.fired_markers("2026-07-01", 14) == {"groceries#80"}


# --- WHIT-555 adversarial gap tests (QA) -----------------------------------------------


def test_rollover_huge_negative_carryover_makes_basis_non_positive_skips_alert(alerts, monkeypatch):
    # basis goes non-positive from a massive deficit: $100 target + (-$110) = -10.
    # basis <= 0 → no crossing check → no push.
    budget = {
        "target": Decimal("100"), "rollover": True, "carryover": Decimal("-110"),
        "carryover_from": "2026-07-01",
        "carryover_len": Decimal("14"), "carryover_paydate": "2026-07-01",
    }
    before = [_txn("old", "groceries", -70, "posted")]
    new = _txn("new1", "groceries", -15, "posted")
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"groceries": budget},
                           before=before, normalised=[new], cats=_SPREAD_CATS)
    assert len(sent) == 0
    assert notify.fired_markers("2026-07-01", 14) == set()


def test_rollover_raised_basis_suppresses_premature_100_crossing(alerts, monkeypatch):
    # $100 target + $60 buffer → basis = 160. 100% = $160, 80% = $128.
    # Before $95, +$10 → $105. $105 > raw $100 but < $128 → no push at all.
    budget = {
        "target": Decimal("100"), "rollover": True, "carryover": Decimal("60"),
        "carryover_from": "2026-07-01",
        "carryover_len": Decimal("14"), "carryover_paydate": "2026-07-01",
    }
    before = [_txn("old", "groceries", -95, "posted")]
    new = _txn("new1", "groceries", -10, "posted")
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"groceries": budget},
                           before=before, normalised=[new], cats=_SPREAD_CATS)
    assert len(sent) == 0
    assert notify.fired_markers("2026-07-01", 14) == set()


def test_rollover_fresh_toggle_no_carryover_from_basis_equals_target(alerts, monkeypatch):
    # Freshly-toggled rollover: rollover=True but no carryover_from → reanchor path,
    # buffer_term = 0, basis = target = 100. $85 crosses 80%.
    budget = {"target": Decimal("100"), "rollover": True}
    before = [_txn("old", "groceries", -70, "posted")]
    new = _txn("new1", "groceries", -15, "posted")
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"groceries": budget},
                           before=before, normalised=[new], cats=_SPREAD_CATS)
    assert len(sent) == 1
    assert "80%" in sent[0][1]


def test_rollover_two_categories_independent_buffers(alerts, monkeypatch):
    # Two rollover categories: groceries ($100 + $50 buffer = basis 150) and
    # coffee ($50 + $0 buffer = basis 50). Only coffee should fire.
    groc_budget = {
        "target": Decimal("100"), "rollover": True, "carryover": Decimal("50"),
        "carryover_from": "2026-07-01",
        "carryover_len": Decimal("14"), "carryover_paydate": "2026-07-01",
    }
    coffee_budget = {
        "target": Decimal("50"), "rollover": True, "carryover": Decimal("0"),
        "carryover_from": "2026-07-01",
        "carryover_len": Decimal("14"), "carryover_paydate": "2026-07-01",
    }
    before = [
        _txn("old1", "groceries", -70, "posted"),
        _txn("old2", "coffee", -35, "posted"),
    ]
    new_groc = _txn("new1", "groceries", -15, "posted")
    new_coffee = _txn("new2", "coffee", -10, "posted")
    cats = [
        {"id": "groceries", "name": "Groceries", "bucket": "Living"},
        {"id": "coffee", "name": "Coffee", "bucket": "Living"},
    ]
    sent, notify, _ = _run(
        alerts, monkeypatch,
        budgets={"groceries": groc_budget, "coffee": coffee_budget},
        before=before, normalised=[new_groc, new_coffee], cats=cats,
    )
    assert len(sent) == 1
    assert "Coffee" in sent[0][1]
    assert notify.fired_markers("2026-07-01", 14) == {"coffee#80"}


def test_rollover_zero_carryover_aligned_basis_equals_target(alerts, monkeypatch):
    # Rollover=True, aligned, zero carryover. buffer_term = 0, basis = target.
    budget = {
        "target": Decimal("100"), "rollover": True, "carryover": Decimal("0"),
        "carryover_from": "2026-07-01",
        "carryover_len": Decimal("14"), "carryover_paydate": "2026-07-01",
    }
    before = [_txn("old", "groceries", -70, "posted")]
    new = _txn("new1", "groceries", -15, "posted")
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"groceries": budget},
                           before=before, normalised=[new], cats=_SPREAD_CATS)
    assert len(sent) == 1
    assert "80%" in sent[0][1]


def test_rollover_basis_exactly_zero_skips_no_crash(alerts, monkeypatch):
    # basis = target + buffer = $50 + (-$50) = 0. Guard catches it, no crash, no push.
    budget = {
        "target": Decimal("50"), "rollover": True, "carryover": Decimal("-50"),
        "carryover_from": "2026-07-01",
        "carryover_len": Decimal("14"), "carryover_paydate": "2026-07-01",
    }
    before = [_txn("old", "groceries", -30, "posted")]
    new = _txn("new1", "groceries", -10, "posted")
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"groceries": budget},
                           before=before, normalised=[new], cats=_SPREAD_CATS)
    assert len(sent) == 0
    assert notify.fired_markers("2026-07-01", 14) == set()


def test_rollover_ctx_rollover_txns_includes_prior_cycle_rows(alerts, monkeypatch):
    # ctx["rollover_txns"] carries both prior- and current-cycle rows.
    # ctx["before_rows"] carries only current-cycle rows.
    budget = {
        "target": Decimal("100"), "rollover": True, "carryover": Decimal("0"),
        "carryover_from": "2026-06-17",
        "carryover_len": Decimal("14"), "carryover_paydate": "2026-07-01",
    }
    prior_txn = _txn("prior1", "groceries", -40, "posted", date="2026-06-20")
    current_txn = _txn("cur1", "groceries", -50, "posted")
    before = [prior_txn, current_txn]
    new = _txn("new1", "groceries", -5, "posted")
    _, _, ctx = _run(alerts, monkeypatch, budgets={"groceries": budget},
                     before=before, normalised=[new], cats=_SPREAD_CATS)
    rollover_ids = {r["transaction_id"] for r in ctx["rollover_txns"]}
    assert "prior1" in rollover_ids
    assert "cur1" in rollover_ids
    before_ids = {r["transaction_id"] for r in ctx["before_rows"]}
    assert "prior1" not in before_ids
    assert "cur1" in before_ids


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

    pending = alerts.banksync.BankSyncClient.normalise(
        _bal_bank_row("PEND", -15, pending=True, category="FOOD_AND_DRINK"))
    repo.insert_transactions([pending])
    posted = alerts.banksync.BankSyncClient.normalise(
        _bal_bank_row("POST", -15, pending=False, category="groceries"))

    before = [_txn("old", "groceries", -70, "posted")]
    ctx = ba.capture_pre_write(
        [posted], device_repo=FakeDeviceRepo(), budget_repo=FakeBudgetRepo({"groceries": {"target": Decimal("100")}}),
        paycycle_repo=FakePaycycleRepo("2026-07-01", 14), window_repo=FakeWindowRepo(before), webhook_repo=repo)
    ba.fire_budget_alerts(
        ctx, [posted], webhook_repo=repo,
        category_repo=FakeCategoryRepo([{"id": "groceries", "name": "Groceries"}]),
        notify_repo=FakeNotifyRepo())

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
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("100")}},
                           before=before, normalised=[], notify=FakeNotifyRepo(lose_claims=True))
    assert sent == []
    assert notify.released == []


def test_combined_push_names_three_budgets_then_counts_the_rest(alerts, monkeypatch):
    names = ["Alpha", "Bravo", "Coffee", "Dining", "Eggs"]
    cats = [{"id": name.lower(), "name": name} for name in names]
    budgets = {name.lower(): {"target": Decimal("100")} for name in names}
    before = [_txn(f"t-{name}", name.lower(), -90, "posted") for name in names]
    sent, _, _ = _run(alerts, monkeypatch, budgets=budgets, before=before, normalised=[], cats=cats)
    assert [(title, body) for title, body, _ in sent] == [
        ("5 budgets need a look", "Alpha, Bravo, Coffee +2 more are at 80% or more of their budget this cycle.")]


def test_combined_push_opens_the_app_not_one_budget(alerts, monkeypatch):
    ba = alerts.budget_alerts
    pushed = []
    monkeypatch.setattr(ba, "send_push",
                        lambda title, body, toks, data=None: (pushed.append(data), {"sent": 1, "ok": 1, "pruned": []})[1])
    cats = [{"id": "groceries", "name": "Groceries"}, {"id": "coffee", "name": "Coffee"}]
    budgets = {"groceries": {"target": Decimal("100")}, "coffee": {"target": Decimal("50")}}
    before = [_txn("g", "groceries", -90, "posted"), _txn("c", "coffee", -45, "posted")]
    ctx = ba.capture_pre_write([], device_repo=FakeDeviceRepo(), budget_repo=FakeBudgetRepo(budgets),
                               paycycle_repo=FakePaycycleRepo(), window_repo=FakeWindowRepo(before),
                               webhook_repo=NoTwinRepo())
    ba.fire_budget_alerts(ctx, [], webhook_repo=NoTwinRepo(), category_repo=FakeCategoryRepo(cats),
                          notify_repo=FakeNotifyRepo())
    assert pushed == [{"type": "budget"}]


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
    notify = FakeNotifyRepo()
    notify.mark_fired("2026-07-01", 14, "coffee#80")
    ctx = ba.capture_pre_write([], device_repo=FakeDeviceRepo(), budget_repo=FakeBudgetRepo(budgets),
                               paycycle_repo=FakePaycycleRepo(), window_repo=FakeWindowRepo(before),
                               webhook_repo=NoTwinRepo())
    ba.fire_budget_alerts(ctx, [], webhook_repo=NoTwinRepo(), category_repo=FakeCategoryRepo(cats),
                          notify_repo=notify)
    assert pushed == [("Heads up \U0001f440", {"type": "budget", "category": "groceries"})]


def test_a_new_cycle_key_warns_an_already_over_budget_again(alerts, monkeypatch):
    # Editing the payday changes the cycle key, so the markers start empty and a budget
    # already over warns once more under the new cycle. Documented, accepted behaviour.
    before = [_txn("old", "groceries", -90, "posted")]
    notify = FakeNotifyRepo()
    notify.mark_fired("2026-06-17", 14, "groceries#80")               # the old cycle's marker
    sent, notify, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("100")}},
                           before=before, normalised=[], notify=notify)
    assert len(sent) == 1
    assert notify.fired_markers("2026-07-01", 14) == {"groceries#80"}


class _RaisingNotifyRepo(FakeNotifyRepo):
    """Raises `error` on the Nth claim or release, to drive the partial-failure paths."""

    def __init__(self, error, fail_claim_number=None, fail_release_number=None):
        super().__init__()
        self._error = error
        self._fail_claim_number = fail_claim_number
        self._fail_release_number = fail_release_number
        self._claims = 0
        self._releases = 0

    def claim_fired(self, cycle_start, length, marker):
        self._claims += 1
        if self._claims == self._fail_claim_number:
            raise self._error("throttled")
        return super().claim_fired(cycle_start, length, marker)

    def release_fired(self, cycle_start, length, marker):
        self._releases += 1
        if self._releases == self._fail_release_number:
            raise self._error("throttled")
        super().release_fired(cycle_start, length, marker)


_THREE_OVER = {
    "budgets": {name: {"target": Decimal("100")} for name in ("alpha", "bravo", "coffee")},
    "before": [_txn(f"t-{name}", name, -90, "posted") for name in ("alpha", "bravo", "coffee")],
    "cats": [{"id": name, "name": name.title()} for name in ("alpha", "bravo", "coffee")],
}


def test_a_claim_that_raises_releases_the_earlier_claims(alerts, monkeypatch):
    # The 2nd claim is throttled: nothing is sent and the 1st claim must be released, or that
    # budget stays silent all cycle. Fail-on-revert: drop the except-release → 1st stays claimed.
    import repository_errors
    notify = _RaisingNotifyRepo(repository_errors.DatabaseError, fail_claim_number=2)
    with pytest.raises(repository_errors.DatabaseError):
        _run(alerts, monkeypatch, budgets=_THREE_OVER["budgets"], before=_THREE_OVER["before"],
             normalised=[], cats=_THREE_OVER["cats"], notify=notify)
    assert notify.fired_markers("2026-07-01", 14) == set()
    assert len(notify.released) == 1


class _ReadTimeoutError(OSError):
    """botocore's ReadTimeoutError is an OSError, not a ClientError, so it is never converted to
    a DatabaseError (the lam fixture stubs botocore, so it is modelled here)."""


@pytest.mark.parametrize("error_name", ["DatabaseError", "ReadTimeoutError"])
def test_one_failed_release_does_not_strand_the_others(alerts, monkeypatch, error_name):
    # A combined push that didn't land: the 1st release is throttled (or times out), the rest
    # still release. Fail-on-revert: a bare loop, or catching only DatabaseError, strands claims.
    import repository_errors
    error = {"DatabaseError": repository_errors.DatabaseError, "ReadTimeoutError": _ReadTimeoutError}[error_name]
    notify = _RaisingNotifyRepo(error, fail_release_number=1)
    sent, notify, _ = _run(alerts, monkeypatch, budgets=_THREE_OVER["budgets"], before=_THREE_OVER["before"],
                           normalised=[], cats=_THREE_OVER["cats"], notify=notify, send_ok=0)
    assert len(sent) == 1
    assert len(notify.released) == 2
    assert len(notify.fired_markers("2026-07-01", 14)) == 1   # only the failed release is left behind


# --- WHIT-577 gaps (qa): send failures, partial claim loss, empty deliveries ------------------


class _StaleSnapshotNotifyRepo(FakeNotifyRepo):
    """Counts claims, and hides markers another in-flight delivery claimed AFTER this
    delivery's snapshot read (`pre_claimed`)."""

    def __init__(self, *, pre_claimed=()):
        super().__init__()
        self.claim_calls = 0
        self._pre_claimed = set(pre_claimed)

    def fired_markers(self, cycle_start, length):
        return super().fired_markers(cycle_start, length) - self._pre_claimed

    def claim_fired(self, cycle_start, length, marker):
        self.claim_calls += 1
        return super().claim_fired(cycle_start, length, marker)






def test_send_that_raises_releases_its_claim(alerts, monkeypatch):
    # send_push promises never to raise; if it ever does, the claim must still be released.
    def boom(*a, **k):
        raise RuntimeError("push blew up")

    ba = alerts.budget_alerts
    notify = FakeNotifyRepo()
    before = [_txn("old", "groceries", -90, "posted")]
    ctx = ba.capture_pre_write([], device_repo=FakeDeviceRepo(),
                               budget_repo=FakeBudgetRepo({"groceries": {"target": Decimal("100")}}),
                               paycycle_repo=FakePaycycleRepo(), window_repo=FakeWindowRepo(before),
                               webhook_repo=NoTwinRepo())
    monkeypatch.setattr(ba, "send_push", boom)
    with pytest.raises(RuntimeError):
        ba.fire_budget_alerts(ctx, [], webhook_repo=NoTwinRepo(),
                              category_repo=FakeCategoryRepo([{"id": "groceries", "name": "Groceries"}]),
                              notify_repo=notify)
    assert notify.fired_markers("2026-07-01", 14) == set()


def test_no_80_nag_after_100_already_sent(alerts, monkeypatch):
    # groceries#100 landed but its 80 mark was lost; a refund drops spend to $85. An 80%
    # "Heads up" after "Budget hit" would be backwards. Fail-on-revert: check only the exact
    # marker → the 80% push goes out.
    notify = FakeNotifyRepo()
    notify.mark_fired("2026-07-01", 14, "groceries#100")
    before = [_txn("old", "groceries", -105, "posted")]
    refund = _txn("r1", "groceries", 20, "posted")
    sent, _, _ = _run(alerts, monkeypatch, budgets={"groceries": {"target": Decimal("100")}},
                      before=before, normalised=[refund], notify=notify)
    assert sent == []


def test_failed_push_never_releases_a_claim_another_delivery_owns(alerts, monkeypatch):
    # Overlapping deliveries: another delivery claimed coffee#100 after this one's snapshot.
    # This one's combined push fails and must release ONLY its own two claims.
    notify = _StaleSnapshotNotifyRepo(pre_claimed={"coffee#100"})
    notify.store[("2026-07-01", 14)] = {"coffee#100"}
    before = [_txn("a", "alpha", -90, "posted"), _txn("b", "bravo", -90, "posted"),
              _txn("c", "coffee", -110, "posted")]
    sent, notify, _ = _run(alerts, monkeypatch, budgets=_THREE_OVER["budgets"], before=before, normalised=[],
                           cats=_THREE_OVER["cats"], notify=notify, send_ok=0)
    assert [title for title, _, _ in sent] == ["2 budgets need a look"]
    assert sorted(notify.released) == ["alpha#80", "bravo#80"]
    assert notify.store[("2026-07-01", 14)] == {"coffee#100"}


def test_single_survivor_of_a_claim_race_gets_its_own_copy(alerts, monkeypatch):
    # Two budgets due; another delivery already claimed bravo#80. The push this delivery sends
    # is alpha's own "Budget hit", deep-linked — not "2 budgets need a look".
    ba = alerts.budget_alerts
    pushed = []
    monkeypatch.setattr(ba, "send_push", lambda t, b, toks, data=None:
                        (pushed.append((t, b, data)), {"sent": 1, "ok": 1, "pruned": []})[1])
    notify = _StaleSnapshotNotifyRepo(pre_claimed={"bravo#80"})
    notify.store[("2026-07-01", 14)] = {"bravo#80"}
    before = [_txn("a", "alpha", -110, "posted"), _txn("b", "bravo", -85, "posted")]
    budgets = {"alpha": {"target": Decimal("100")}, "bravo": {"target": Decimal("100")}}
    ctx = ba.capture_pre_write([], device_repo=FakeDeviceRepo(), budget_repo=FakeBudgetRepo(budgets),
                               paycycle_repo=FakePaycycleRepo(), window_repo=FakeWindowRepo(before),
                               webhook_repo=NoTwinRepo())
    ba.fire_budget_alerts(ctx, [], webhook_repo=NoTwinRepo(), category_repo=FakeCategoryRepo(_THREE_OVER["cats"]),
                          notify_repo=notify)
    assert pushed == [("Budget hit", "You've spent your whole Alpha budget for this cycle.",
                       {"type": "budget", "category": "alpha"})]
    assert notify.store[("2026-07-01", 14)] == {"alpha#100", "alpha#80", "bravo#80"}


def test_repeat_delivery_skips_claims_for_already_fired_budgets(alerts, monkeypatch):
    # Every budget is over and already warned; each hourly delivery re-checks them, and must
    # not issue a doomed conditional write per budget per delivery.
    notify = _StaleSnapshotNotifyRepo()
    for cat in ("alpha", "bravo", "coffee"):
        notify.mark_fired("2026-07-01", 14, f"{cat}#80")
    sent, _, _ = _run(alerts, monkeypatch, budgets=_THREE_OVER["budgets"], before=_THREE_OVER["before"], normalised=[],
                      cats=_THREE_OVER["cats"], notify=notify)
    assert sent == []
    assert notify.claim_calls == 0


def test_dataless_delivery_still_runs_the_alert_check(lam, monkeypatch):
    # The fix rests on "the next delivery, even an empty sync" re-checking levels.
    # Fail-on-revert: an early return for an empty payload in process_transaction.
    calls = []
    monkeypatch.setattr(lam.budget_alerts, "capture_pre_write", lambda normalised, **k: {"ctx": True})
    monkeypatch.setattr(lam.budget_alerts, "fire_budget_alerts",
                        lambda ctx, normalised, **k: calls.append((ctx, list(normalised))))
    lam.handler.process_transaction({"id": "sync-completed-1"}, _WriteRecordingRepo())
    assert calls == [({"ctx": True}, [])]
