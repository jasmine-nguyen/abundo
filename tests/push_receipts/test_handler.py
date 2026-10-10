"""Tests for the push-receipts sweep handler (lambda_push_receipts/handler.py) — WHIT-139.

No AWS, no network: the handler's stores (PushReceiptRepository, DeviceRepository) and its
Expo poll (get_receipts) are replaced with recording fakes. Locks the per-receipt outcome
matrix — ok → delete, DeviceNotRegistered → prune + delete, any other error →
PUSH_DELIVERY_FAILED log + delete, an id Expo hasn't resolved → left untouched — plus the
best-effort contract (one bad receipt, an SSM failure, or a store blow-up never breaks the
rest or errors the invocation).
"""

import logging

import pytest

_ZERO = {"pending": 0, "ok": 0, "pruned": 0, "failed": 0}


class _FakeReceiptRepo:
    """Serves a fixed pending list and records which ids the sweep deleted."""

    def __init__(self, pending):
        self._pending = pending
        self.deleted = []

    def list_pending(self):
        return list(self._pending)

    def delete(self, receipt_id):
        self.deleted.append(receipt_id)


class _FakeDeviceRepo:
    """Records which dead tokens the sweep pruned."""

    def __init__(self):
        self.removed = []

    def remove(self, token):
        self.removed.append(token)


def _wire(handler, monkeypatch, *, pending, receipts, token="token"):
    """Install fake stores + a canned get_receipts, and return (receipt_repo, device_repo)."""
    receipt_repo = _FakeReceiptRepo(pending)
    device_repo = _FakeDeviceRepo()
    monkeypatch.setattr(handler, "PushReceiptRepository", lambda: receipt_repo)
    monkeypatch.setattr(handler, "DeviceRepository", lambda: device_repo)
    monkeypatch.setattr(handler, "get_access_token", lambda: token)
    monkeypatch.setattr(handler, "get_receipts",
                        lambda ids, access_token=None: dict(receipts))
    return receipt_repo, device_repo


def test_other_error_logs_delivery_failed_and_deletes(handler, monkeypatch, caplog):
    receipt_repo, device_repo = _wire(
        handler, monkeypatch,
        pending=[("r1", "tok1")],
        receipts={"r1": {"status": "error", "details": {"error": "MessageTooBig"}}})

    with caplog.at_level(logging.ERROR):
        out = handler.lambda_handler({}, None)

    # The distinct token the delivery-failure alarm matches, with the Expo error code.
    assert "PUSH_DELIVERY_FAILED" in caplog.text
    assert "MessageTooBig" in caplog.text
    assert receipt_repo.deleted == ["r1"]        # cleared (Expo gave a terminal answer)
    assert device_repo.removed == []             # not a dead-device case
    assert out == {"pending": 1, "ok": 0, "pruned": 0, "failed": 1}


@pytest.mark.parametrize("receipt", ["garbage", {}], ids=["not-a-dict", "missing-status"])
def test_an_uninterpretable_receipt_is_a_failure(handler, monkeypatch, caplog, receipt):
    # A receipt that can't be interpreted is logged and cleared, not left pending forever.
    receipt_repo, device_repo = _wire(
        handler, monkeypatch,
        pending=[("r1", "tok1")], receipts={"r1": receipt})

    with caplog.at_level(logging.ERROR):
        out = handler.lambda_handler({}, None)

    assert "PUSH_DELIVERY_FAILED" in caplog.text
    assert receipt_repo.deleted == ["r1"]
    assert out == {"pending": 1, "ok": 0, "pruned": 0, "failed": 1}


def test_one_receipt_failure_does_not_abort_the_rest(handler, monkeypatch):
    # A delete raising for one id must not skip the others (best-effort per receipt).
    class _PartlyBoomRepo(_FakeReceiptRepo):
        def delete(self, receipt_id):
            if receipt_id == "r1":
                raise RuntimeError("dynamo down")
            super().delete(receipt_id)

    receipt_repo = _PartlyBoomRepo([("r1", "t1"), ("r2", "t2")])
    monkeypatch.setattr(handler, "PushReceiptRepository", lambda: receipt_repo)
    monkeypatch.setattr(handler, "DeviceRepository", lambda: _FakeDeviceRepo())
    monkeypatch.setattr(handler, "get_access_token", lambda: "token")
    monkeypatch.setattr(handler, "get_receipts", lambda ids, access_token=None: {
        "r1": {"status": "ok"}, "r2": {"status": "ok"}})

    out = handler.lambda_handler({}, None)

    assert receipt_repo.deleted == ["r2"]        # r1 blew up, r2 still processed
    assert out == {"pending": 2, "ok": 1, "pruned": 0, "failed": 0}


def test_ssm_token_failure_skips_the_sweep(handler, monkeypatch):
    # A token read failure skips the poll entirely (an unauth getReceipts would fail),
    # leaving every pending row for the next run — the invocation still returns cleanly.
    receipt_repo = _FakeReceiptRepo([("r1", "t1")])
    monkeypatch.setattr(handler, "PushReceiptRepository", lambda: receipt_repo)

    def boom():
        raise RuntimeError("ssm down")

    monkeypatch.setattr(handler, "get_access_token", boom)

    out = handler.lambda_handler({}, None)

    assert out == _ZERO
    assert receipt_repo.deleted == []            # never swept


def test_top_level_sweep_exception_is_swallowed(handler, monkeypatch):
    class _BoomRepo:
        def list_pending(self):
            raise RuntimeError("dynamo down")

    monkeypatch.setattr(handler, "PushReceiptRepository", lambda: _BoomRepo())
    monkeypatch.setattr(handler, "get_access_token", lambda: "token")

    out = handler.lambda_handler({}, None)

    assert out == _ZERO                          # never raised


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
