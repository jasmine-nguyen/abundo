"""Home-loan repayment push notifications (shared/repayment_alerts.py), WHIT-15.

Driven through the webhook `lam` fixture (so repayment_alerts + constants + the real
banksync normaliser resolve exactly as the deployed webhook loads them). `send_push`
is stubbed to capture pushes; a FakeDeviceRepo supplies tokens; a FakeNotifyRepo
models the per-repayment-id debounce set.

Detection is asserted against rows produced by the REAL BankSyncClient.normalise
(from a home-loan `TRANSFER_INCOMING` payload), so the test can't drift from what
lands on the write path — the classifier keys on HOMELOAN_ACCOUNT_ID + the type, not
a description string.
"""

from decimal import Decimal

import pytest

_HOMELOAN_BANK_ACCT = "T6d8ppsYssBDFCwl1qEb0w"  # -> "up-homeloan" via ACCOUNT_ID_MAP
_SPENDING_BANK_ACCT = "3zVQJ8Btz_IRmqp78VrQnQ"  # -> "up-spending"


def _bank(txn_id, amount, *, account=_HOMELOAN_BANK_ACCT, txn_type="TRANSFER_INCOMING",
          category="TRANSFER_IN", pending=False, description="Transfer from Spending"):
    """A raw BankSync row, shaped as BankSyncClient.normalise expects."""
    return {
        "id": txn_id, "date": "2026-07-01", "authorizedDate": "2026-07-01",
        "description": description, "merchantName": "",
        "amount": amount, "accountId": account, "accountName": "Up Home Loan",
        "category": category, "pending": pending, "type": txn_type,
        "pendingTransactionId": None,
    }


def _norm(lam, **kw):
    return lam.banksync.BankSyncClient.normalise(_bank(**kw))


class FakeDeviceRepo:
    def __init__(self, tokens=("ExpoPushToken[a]",)):
        self._t = list(tokens)

    def list_tokens(self):
        return list(self._t)


class FakeNotifyRepo:
    """Per-repayment-id debounce set, matching NotifyRepository's repayment methods."""

    def __init__(self, fired=()):
        self.fired = set(fired)
        self.order: list = []

    def fired_repayments(self):
        return set(self.fired)

    def mark_repayment_fired(self, txn_id):
        self.fired.add(txn_id)
        self.order.append(txn_id)


def _run(lam, monkeypatch, normalised, *, tokens=("ExpoPushToken[a]",), notify=None):
    ra = lam.repayment_alerts
    sent = []
    monkeypatch.setattr(ra, "send_push", lambda title, body, toks: sent.append((title, body, list(toks))))
    notify = notify if notify is not None else FakeNotifyRepo()
    ra.notify_repayments(normalised, device_repo=FakeDeviceRepo(tokens), notify_repo=notify)
    return sent, notify


# --- fires on a qualifying repayment -----------------------------------------


def test_repayment_fires_one_push_with_the_amount(lam, monkeypatch):
    txn = _norm(lam, txn_id="r1", amount=Decimal("3667"))
    sent, notify = _run(lam, monkeypatch, [txn])
    assert len(sent) == 1
    title, body, toks = sent[0]
    assert title == "Nice one! \U0001fa93 Another chunk down"
    assert "$3,667 toward the mortgage" in body
    assert toks == ["ExpoPushToken[a]"]
    assert notify.fired == {"r1"}


def test_detection_keys_on_account_and_type_not_description(lam, monkeypatch):
    # Same qualifying credit but an unrelated description → still detected, because the
    # classifier anchors on HOMELOAN_ACCOUNT_ID + TRANSFER_INCOMING, not the text.
    txn = _norm(lam, txn_id="r1", amount=Decimal("3667"), description="OHA Repayment 12345")
    sent, _ = _run(lam, monkeypatch, [txn])
    assert len(sent) == 1


def test_amount_with_cents_renders_whole_dollars(lam, monkeypatch):
    txn = _norm(lam, txn_id="r1", amount=Decimal("3667.50"))
    sent, _ = _run(lam, monkeypatch, [txn])
    assert "$3,668 toward the mortgage" in sent[0][1]  # 3667.50 rounds to 3,668


# --- does NOT fire on non-repayments -----------------------------------------


def test_ordinary_spending_transaction_does_not_fire(lam, monkeypatch):
    txn = _norm(lam, txn_id="s1", amount=Decimal("-42"), account=_SPENDING_BANK_ACCT,
                txn_type="PAYMENT", category="GROCERIES")
    sent, _ = _run(lam, monkeypatch, [txn])
    assert sent == []


def test_loan_payments_debit_leaving_spending_does_not_fire(lam, monkeypatch):
    # The DEBIT leg leaving up-spending (LOAN_PAYMENTS) is deliberately NOT the trigger
    # — only the credit landing on up-homeloan is. Firing on both would double-notify.
    txn = _norm(lam, txn_id="d1", amount=Decimal("-3667"), account=_SPENDING_BANK_ACCT,
                txn_type="TRANSFER_OUT", category="LOAN_PAYMENTS")
    sent, _ = _run(lam, monkeypatch, [txn])
    assert sent == []


def test_interest_debit_on_homeloan_does_not_fire(lam, monkeypatch):
    # Interest posts as a BANK_FEES debit (negative) on up-homeloan — not a repayment.
    txn = _norm(lam, txn_id="i1", amount=Decimal("-2525.82"), txn_type="TRANSFER_OUT",
                category="BANK_FEES", description="Interest")
    sent, _ = _run(lam, monkeypatch, [txn])
    assert sent == []


def test_pending_repayment_does_not_fire(lam, monkeypatch):
    # POSTED only: a pending leg settles under a new id, so firing on pending would
    # double-notify. The pending row is skipped; the posted twin fires later.
    txn = _norm(lam, txn_id="p1", amount=Decimal("3667"), pending=True)
    sent, _ = _run(lam, monkeypatch, [txn])
    assert sent == []


# --- below-minimum "OHA test" rows -------------------------------------------


@pytest.mark.parametrize("amount", ["1", "2", "5", "9.99"])
def test_below_min_amount_is_skipped(lam, monkeypatch, amount):
    txn = _norm(lam, txn_id="t1", amount=Decimal(amount))
    sent, _ = _run(lam, monkeypatch, [txn])
    assert sent == []


def test_exactly_the_min_amount_fires(lam, monkeypatch):
    # The floor is inclusive: exactly $10 notifies.
    txn = _norm(lam, txn_id="r1", amount=Decimal("10"))
    sent, _ = _run(lam, monkeypatch, [txn])
    assert len(sent) == 1


# --- no tokens / debounce ----------------------------------------------------


def test_no_tokens_sends_nothing(lam, monkeypatch):
    txn = _norm(lam, txn_id="r1", amount=Decimal("3667"))
    sent, notify = _run(lam, monkeypatch, [txn], tokens=())
    assert sent == []
    assert notify.fired == set()  # nothing marked when nothing sent


def test_already_notified_repayment_does_not_refire(lam, monkeypatch):
    txn = _norm(lam, txn_id="r1", amount=Decimal("3667"))
    sent, _ = _run(lam, monkeypatch, [txn], notify=FakeNotifyRepo(fired={"r1"}))
    assert sent == []


def test_different_repayment_id_fires(lam, monkeypatch):
    txn = _norm(lam, txn_id="r2", amount=Decimal("3667"))
    sent, _ = _run(lam, monkeypatch, [txn], notify=FakeNotifyRepo(fired={"r1"}))
    assert len(sent) == 1


# --- batches -----------------------------------------------------------------


def test_two_repayments_in_one_batch_send_two_pushes(lam, monkeypatch):
    batch = [_norm(lam, txn_id="r1", amount=Decimal("3667")),
             _norm(lam, txn_id="r2", amount=Decimal("500"))]
    sent, notify = _run(lam, monkeypatch, batch)
    assert len(sent) == 2
    assert notify.fired == {"r1", "r2"}


def test_only_the_repayment_in_a_mixed_batch_fires(lam, monkeypatch):
    batch = [
        _norm(lam, txn_id="s1", amount=Decimal("-42"), account=_SPENDING_BANK_ACCT,
              txn_type="PAYMENT", category="GROCERIES"),
        _norm(lam, txn_id="r1", amount=Decimal("3667")),
        _norm(lam, txn_id="i1", amount=Decimal("-2525.82"), txn_type="TRANSFER_OUT",
              category="BANK_FEES"),
    ]
    sent, notify = _run(lam, monkeypatch, batch)
    assert len(sent) == 1
    assert notify.fired == {"r1"}


def test_empty_batch_sends_nothing_without_reading_tokens(lam, monkeypatch):
    ra = lam.repayment_alerts

    class ExplodingDeviceRepo:
        def list_tokens(self):
            raise AssertionError("must not read tokens when the batch has no repayment")

    monkeypatch.setattr(ra, "send_push", lambda *a: (_ for _ in ()).throw(AssertionError("no send")))
    ra.notify_repayments([], device_repo=ExplodingDeviceRepo(), notify_repo=FakeNotifyRepo())  # no raise


# --- send-then-mark ordering -------------------------------------------------


def test_send_precedes_mark(lam, monkeypatch):
    ra = lam.repayment_alerts
    order = []
    monkeypatch.setattr(ra, "send_push", lambda *a: order.append("send"))
    notify = FakeNotifyRepo()
    orig = notify.mark_repayment_fired
    notify.mark_repayment_fired = lambda tid: (order.append("mark"), orig(tid))[1]
    ra.notify_repayments([_norm(lam, txn_id="r1", amount=Decimal("3667"))],
                         device_repo=FakeDeviceRepo(), notify_repo=notify)
    assert order == ["send", "mark"]


# --- the webhook straddle is best-effort: a push failure never breaks the write --


class _WriteRecordingRepo:
    def save_failed_transactions(self, rows):
        pass

    def insert_or_reconcile(self, txns):
        self.wrote = True


def test_notify_failure_does_not_break_the_write(lam, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("boom")

    # Neutralise the WHIT-22 block so this isolates the WHIT-15 call.
    monkeypatch.setattr(lam.budget_alerts, "capture_pre_write", lambda *a, **k: None)
    monkeypatch.setattr(lam.repayment_alerts, "notify_repayments", boom)
    repo = _WriteRecordingRepo()
    lam.handler.process_transaction({"id": "e1", "data": []}, repo)  # must not raise
    assert repo.wrote is True


# --- gate isolation: each detection gate has an independent fail-on-revert test --
# The negative tests above fail MULTIPLE gates at once (wrong type AND account, or
# sign); these flip exactly ONE gate off an otherwise-qualifying row so a revert of
# that single gate goes red.


def test_transfer_incoming_on_non_homeloan_account_does_not_fire(lam, monkeypatch):
    # A qualifying credit (posted TRANSFER_INCOMING >= $10) on up-spending must NOT
    # fire — only the home-loan account does. Isolates the account gate: incoming
    # transfers to Spending are real TRANSFER_INCOMING credits, so if the account
    # check were dropped/inverted they'd false-fire.
    txn = _norm(lam, txn_id="x1", amount=Decimal("3667"), account=_SPENDING_BANK_ACCT)
    sent, _ = _run(lam, monkeypatch, [txn])
    assert sent == []


def test_non_transfer_incoming_credit_on_homeloan_does_not_fire(lam, monkeypatch):
    # A posted positive credit on up-homeloan that isn't TRANSFER_INCOMING must NOT
    # fire — all other gates (account, status, amount) pass. Isolates the type gate.
    txn = _norm(lam, txn_id="y1", amount=Decimal("3667"), txn_type="TRANSFER_IN")
    sent, _ = _run(lam, monkeypatch, [txn])
    assert sent == []


# ===========================================================================
# QA gap tests (WHIT-15) — adversarial coverage the implementer's happy-path
# list omits: end-to-end process_transaction (push AND write), coexistence with
# the WHIT-22 budget-alert block, in-batch same-id dedupe vs distinct-id double
# fire, negative/boundary amounts, banker's-rounding display, missing id, and
# the send-then-mark ordering under a RAISING send_push. Every assertion fails
# on a revert of the behaviour it names.
# ===========================================================================


class _RecordingRepo:
    """Webhook repo stand-in: records that the write ran and what it wrote, so a
    test can assert the push path never displaced the transaction write."""

    def __init__(self):
        self.wrote = False
        self.written = None
        self.failed = None

    def save_failed_transactions(self, rows):
        self.failed = list(rows)

    def insert_or_reconcile(self, txns):
        self.wrote = True
        self.written = list(txns)


def _drive(lam, monkeypatch, data, *, tokens=("ExpoPushToken[a]",), notify=None,
           capture=None, fire=None):
    """Drive the REAL handler.process_transaction with a raw payload.

    Neutralises the WHIT-22 budget block by default (capture -> None) so this
    isolates the WHIT-15 straddle; pass `capture`/`fire` to exercise coexistence.
    DeviceRepository / NotifyRepository are swapped for fakes on the handler
    module (the two names it constructs for the repayment push). send_push is
    captured off repayment_alerts.
    """
    sent = []
    monkeypatch.setattr(lam.repayment_alerts, "send_push",
                        lambda title, body, toks: sent.append((title, body, list(toks))))
    monkeypatch.setattr(lam.budget_alerts, "capture_pre_write",
                        capture if capture is not None else (lambda *a, **k: None))
    if fire is not None:
        monkeypatch.setattr(lam.budget_alerts, "fire_if_crossed", fire)
    monkeypatch.setattr(lam.handler, "DeviceRepository", lambda: FakeDeviceRepo(tokens))
    notify = notify if notify is not None else FakeNotifyRepo()
    monkeypatch.setattr(lam.handler, "NotifyRepository", lambda: notify)
    repo = _RecordingRepo()
    lam.handler.process_transaction({"id": "e1", "data": data}, repo)
    return sent, notify, repo


# --- end-to-end through process_transaction: push AND write ------------------


def test_process_transaction_end_to_end_fires_one_push_and_writes(lam, monkeypatch):
    # A raw webhook payload with one posted home-loan repayment: the real
    # normalise + is_homeloan_repayment run, exactly one push fires, and the
    # transaction reaches insert_or_reconcile. The implementer only tested
    # notify_repayments in isolation; this locks the handler wiring.
    sent, notify, repo = _drive(lam, monkeypatch, [_bank(txn_id="r1", amount=Decimal("3667"))])
    assert repo.wrote is True
    assert [t["transaction_id"] for t in repo.written] == ["r1"]
    assert len(sent) == 1
    assert "$3,667 toward the mortgage" in sent[0][1]
    assert notify.fired == {"r1"}


def test_process_transaction_only_the_repayment_in_a_real_mixed_payload_fires(lam, monkeypatch):
    # Interest debit + repayment credit + ordinary spend in one payload → one
    # push, but ALL rows are written (notify never gates the write).
    data = [
        _bank(txn_id="i1", amount=Decimal("-2525.82"), txn_type="TRANSFER_OUT",
              category="BANK_FEES", description="Interest"),
        _bank(txn_id="r1", amount=Decimal("3667")),
        _bank(txn_id="s1", amount=Decimal("-42"), account=_SPENDING_BANK_ACCT,
              txn_type="PAYMENT", category="GROCERIES"),
    ]
    sent, notify, repo = _drive(lam, monkeypatch, data)
    assert repo.wrote is True
    assert len(repo.written) == 3
    assert len(sent) == 1
    assert notify.fired == {"r1"}


def test_repayment_fires_even_when_the_budget_alert_block_raises(lam, monkeypatch):
    # The two best-effort blocks are independent: a WHIT-22 fire_if_crossed
    # explosion must NOT stop the WHIT-15 push, and the write still completes.
    def boom(*a, **k):
        raise RuntimeError("budget boom")

    sent, notify, repo = _drive(
        lam, monkeypatch, [_bank(txn_id="r1", amount=Decimal("3667"))],
        capture=lambda *a, **k: {"stub": True}, fire=boom,
    )
    assert repo.wrote is True
    assert len(sent) == 1
    assert notify.fired == {"r1"}


def test_process_transaction_swallows_a_send_push_failure(lam, monkeypatch):
    # A realistic failure: the real notify_repayments runs but send_push raises.
    # The handler's best-effort wrapper must swallow it — write still completes,
    # no exception escapes. (Stronger than replacing notify_repayments wholesale.)
    def boom(*a, **k):
        raise RuntimeError("expo down")

    monkeypatch.setattr(lam.repayment_alerts, "send_push", boom)
    monkeypatch.setattr(lam.budget_alerts, "capture_pre_write", lambda *a, **k: None)
    monkeypatch.setattr(lam.handler, "DeviceRepository", lambda: FakeDeviceRepo())
    monkeypatch.setattr(lam.handler, "NotifyRepository", lambda: FakeNotifyRepo())
    repo = _RecordingRepo()
    lam.handler.process_transaction(
        {"id": "e1", "data": [_bank(txn_id="r1", amount=Decimal("3667"))]}, repo)  # no raise
    assert repo.wrote is True


# --- in-batch dedupe vs distinct-id double fire ------------------------------


def test_duplicate_id_within_one_batch_sends_one_push(lam, monkeypatch):
    # Same posted id twice in one batch → the local `fired.add` guard sends once
    # and marks once (the notify_repo read wouldn't catch the second in-batch copy).
    txn = _norm(lam, txn_id="r1", amount=Decimal("3667"))
    sent, notify = _run(lam, monkeypatch, [txn, txn])
    assert len(sent) == 1
    assert notify.order == ["r1"]  # marked exactly once


def test_two_distinct_ids_for_one_repayment_both_fire(lam, monkeypatch):
    # DOCUMENTS ACTUAL BEHAVIOUR (acceptable-for-scope): the per-id marker can't
    # tell that two DIFFERENT posted ids describe the same underlying repayment
    # (same amount, same day) → BOTH fire. Up gives each posted ledger entry a
    # stable unique id, so this is vanishingly unlikely; a revert to any cross-id
    # dedupe would change this expectation.
    batch = [_norm(lam, txn_id="r1", amount=Decimal("3667")),
             _norm(lam, txn_id="r2", amount=Decimal("3667"))]
    sent, notify = _run(lam, monkeypatch, batch)
    assert len(sent) == 2
    assert notify.fired == {"r1", "r2"}


# --- boundary amounts --------------------------------------------------------


def test_negative_transfer_incoming_reversal_does_not_fire(lam, monkeypatch):
    # A reversal posts as a NEGATIVE TRANSFER_INCOMING on the loan. amount >= $10
    # is False for -3667, so no "you put $X toward the mortgage" on a reversal.
    txn = _norm(lam, txn_id="rev1", amount=Decimal("-3667"))
    sent, _ = _run(lam, monkeypatch, [txn])
    assert sent == []


def test_exactly_ten_dollars_with_cents_fires_and_renders_ten(lam, monkeypatch):
    # The inclusive floor at a cents-carrying boundary: $10.00 fires, renders "$10".
    txn = _norm(lam, txn_id="r1", amount=Decimal("10.00"))
    sent, _ = _run(lam, monkeypatch, [txn])
    assert len(sent) == 1
    assert "$10 toward the mortgage" in sent[0][1]


def test_any_positive_transfer_incoming_on_homeloan_fires_regardless_of_category(lam, monkeypatch):
    # Detection ignores category/description: ANY posted positive TRANSFER_INCOMING
    # >= $10 on up-homeloan fires. Documents the false-fire surface — a hypothetical
    # non-repayment credit posted as TRANSFER_INCOMING would say "you put $X toward
    # the mortgage". Acceptable-for-scope (no known Up credit does this) but a real
    # risk if Up's data shape changes.
    txn = _norm(lam, txn_id="x1", amount=Decimal("500"), category="BANK_FEES",
                description="Interest refund")
    sent, _ = _run(lam, monkeypatch, [txn])
    assert len(sent) == 1


# --- missing id / defensive guard --------------------------------------------


def test_repayment_with_missing_transaction_id_is_skipped(lam, monkeypatch):
    # normalise always sets transaction_id = str(row["id"]) so None can't come off
    # the real feed, but notify_repayments guards `txn_id is None`. Force it: the
    # row is detected (account+type+status+amount) yet skipped without crashing.
    txn = dict(_norm(lam, txn_id="r1", amount=Decimal("3667")))
    txn["transaction_id"] = None
    sent, notify = _run(lam, monkeypatch, [txn])
    assert sent == []
    assert notify.fired == set()


# --- _format_amount display rules --------------------------------------------


def test_amount_uses_bankers_rounding_half_to_even(lam, monkeypatch):
    # Python format() rounds half-to-even: 3668.50 -> "3,668" (even), NOT "3,669".
    # Locks the display rule so a switch to ROUND_HALF_UP is a conscious change.
    txn = _norm(lam, txn_id="r1", amount=Decimal("3668.50"))
    sent, _ = _run(lam, monkeypatch, [txn])
    assert "$3,668 toward the mortgage" in sent[0][1]


def test_large_amount_gets_thousands_separators(lam, monkeypatch):
    txn = _norm(lam, txn_id="r1", amount=Decimal("1000000"))
    sent, _ = _run(lam, monkeypatch, [txn])
    assert "$1,000,000 toward the mortgage" in sent[0][1]


# --- send-then-mark ordering under a RAISING send_push -----------------------


def test_send_push_raising_skips_mark_and_propagates(lam, monkeypatch):
    # send_push is documented never-raise, but IF it did, the mark must not run —
    # so a re-ingest re-sends (never a lost push, at worst a duplicate). Asserts
    # notify_repayments does NOT swallow internally; it relies on the handler's
    # best-effort wrapper (proven by test_process_transaction_swallows_...).
    ra = lam.repayment_alerts

    def boom(*a):
        raise RuntimeError("expo down")

    monkeypatch.setattr(ra, "send_push", boom)
    notify = FakeNotifyRepo()
    with pytest.raises(RuntimeError):
        ra.notify_repayments([_norm(lam, txn_id="r1", amount=Decimal("3667"))],
                             device_repo=FakeDeviceRepo(), notify_repo=notify)
    assert notify.fired == set()   # mark NOT reached
    assert notify.order == []
