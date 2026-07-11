"""Adversarial gap tests for the WHIT-139 receipt-sweep handler (lambda_push_receipts/
handler.py) — the malformed-receipt and ordering edges the implementer's test_handler.py
leaves open.

Covers: [A10] status=="error" with NO details → failed (error=None);
[A11] a receipt dict with no `status` key at all → failed;
[A12] a DNR whose token-prune raises leaves the row PENDING (documents the remove-before-
delete ordering — flagged in the critique);
[A13] mixed outcomes in one sweep are counted correctly regardless of dict order.
Fakes mirror tests/push_receipts/conftest.py's install pattern.
"""

import logging


class _FakeReceiptRepo:
    def __init__(self, pending):
        self._pending = pending
        self.deleted = []

    def list_pending(self):
        return list(self._pending)

    def delete(self, receipt_id):
        self.deleted.append(receipt_id)


class _FakeDeviceRepo:
    def __init__(self):
        self.removed = []

    def remove(self, token):
        self.removed.append(token)


def _wire(handler, monkeypatch, *, pending, receipts, device_repo=None, token="token"):
    receipt_repo = _FakeReceiptRepo(pending)
    device_repo = device_repo or _FakeDeviceRepo()
    monkeypatch.setattr(handler, "PushReceiptRepository", lambda: receipt_repo)
    monkeypatch.setattr(handler, "DeviceRepository", lambda: device_repo)
    monkeypatch.setattr(handler, "get_access_token", lambda: token)
    monkeypatch.setattr(handler, "get_receipts",
                        lambda ids, access_token=None: dict(receipts))
    return receipt_repo, device_repo


# WHIT-139 — [A10] status=="error" but NO details key → error is None → failed + delete
def test_error_status_without_details_is_a_failure(handler, monkeypatch, caplog):
    receipt_repo, device_repo = _wire(
        handler, monkeypatch,
        pending=[("r1", "tok1")], receipts={"r1": {"status": "error"}})

    with caplog.at_level(logging.ERROR):
        out = handler.lambda_handler({}, None)

    assert "PUSH_DELIVERY_FAILED" in caplog.text
    assert "error=None" in caplog.text           # no details → error code is None
    assert receipt_repo.deleted == ["r1"]        # still terminal → cleared
    assert device_repo.removed == []             # not a DNR → nothing pruned
    assert out == {"pending": 1, "ok": 0, "pruned": 0, "failed": 1}


# WHIT-139 — [A11] a receipt dict with no `status` key at all → failed (not left pending)
def test_receipt_missing_status_key_is_a_failure(handler, monkeypatch, caplog):
    receipt_repo, device_repo = _wire(
        handler, monkeypatch,
        pending=[("r1", "tok1")], receipts={"r1": {}})

    with caplog.at_level(logging.ERROR):
        out = handler.lambda_handler({}, None)

    assert "PUSH_DELIVERY_FAILED" in caplog.text
    assert receipt_repo.deleted == ["r1"]        # cleared, not silently left forever
    assert out == {"pending": 1, "ok": 0, "pruned": 0, "failed": 1}


# WHIT-139 — [A12] DNR whose token-prune raises leaves the row PENDING (remove-before-delete)
def test_dnr_prune_failure_leaves_the_row_pending(handler, monkeypatch, caplog):
    # In the DNR branch remove(token) runs BEFORE delete(rid); if remove raises, the
    # per-receipt try/except swallows it and delete never runs → the row survives for a
    # later sweep (TTL is the backstop). Locks that ordering; flagged in the critique.
    class _AngryDeviceRepo(_FakeDeviceRepo):
        def remove(self, token):
            raise RuntimeError("dynamo down")

    angry = _AngryDeviceRepo()
    receipt_repo, device_repo = _wire(
        handler, monkeypatch,
        pending=[("r1", "tok-dead")],
        receipts={"r1": {"status": "error", "details": {"error": "DeviceNotRegistered"}}},
        device_repo=angry)

    with caplog.at_level(logging.ERROR):
        out = handler.lambda_handler({}, None)

    assert receipt_repo.deleted == []            # row NOT cleared — prune blocked the delete
    assert angry.removed == []                   # remove raised, nothing recorded
    assert out == {"pending": 1, "ok": 0, "pruned": 0, "failed": 0}  # not counted pruned


# WHIT-139 — [A13] mixed outcomes counted correctly regardless of response order
def test_mixed_outcomes_counts_are_order_independent(handler, monkeypatch):
    # One sweep with an ok, a DNR, a hard error, and an unresolved (absent) id — the
    # summary counts must be exact and independent of dict iteration order.
    receipt_repo, device_repo = _wire(
        handler, monkeypatch,
        pending=[("ok1", "t-ok"), ("dnr1", "t-dead"), ("err1", "t-err"),
                 ("wait1", "t-wait")],
        receipts={
            "err1": {"status": "error", "details": {"error": "MessageTooBig"}},
            "ok1": {"status": "ok"},
            "dnr1": {"status": "error", "details": {"error": "DeviceNotRegistered"}},
            # wait1 deliberately absent → still in flight
        })

    out = handler.lambda_handler({}, None)

    assert out == {"pending": 4, "ok": 1, "pruned": 1, "failed": 1}
    assert device_repo.removed == ["t-dead"]                 # only the DNR token
    assert sorted(receipt_repo.deleted) == ["dnr1", "err1", "ok1"]  # wait1 left pending
