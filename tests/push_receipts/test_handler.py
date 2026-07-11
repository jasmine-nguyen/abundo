"""Tests for the push-receipts sweep handler (lambda_push_receipts/handler.py) — WHIT-139.

No AWS, no network: the handler's stores (PushReceiptRepository, DeviceRepository) and its
Expo poll (get_receipts) are replaced with recording fakes. Locks the per-receipt outcome
matrix — ok → delete, DeviceNotRegistered → prune + delete, any other error →
PUSH_DELIVERY_FAILED log + delete, an id Expo hasn't resolved → left untouched — plus the
best-effort contract (one bad receipt, an SSM failure, or a store blow-up never breaks the
rest or errors the invocation).
"""

import logging

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


def test_ok_receipt_is_deleted_and_nothing_pruned(handler, monkeypatch):
    receipt_repo, device_repo = _wire(
        handler, monkeypatch,
        pending=[("r1", "tok1")], receipts={"r1": {"status": "ok"}})

    out = handler.lambda_handler({}, None)

    assert receipt_repo.deleted == ["r1"]
    assert device_repo.removed == []
    assert out == {"pending": 1, "ok": 1, "pruned": 0, "failed": 0}


def test_device_not_registered_prunes_the_token_and_deletes(handler, monkeypatch):
    receipt_repo, device_repo = _wire(
        handler, monkeypatch,
        pending=[("r1", "tok-dead")],
        receipts={"r1": {"status": "error", "details": {"error": "DeviceNotRegistered"}}})

    out = handler.lambda_handler({}, None)

    assert device_repo.removed == ["tok-dead"]   # dead device pruned
    assert receipt_repo.deleted == ["r1"]        # row cleared
    assert out == {"pending": 1, "ok": 0, "pruned": 1, "failed": 0}


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


def test_unresolved_id_is_left_for_the_next_sweep(handler, monkeypatch):
    # Expo only resolved r1; r2 is still in flight and absent from the response, so its
    # row must NOT be deleted — the next sweep retries it (TTL is the backstop).
    receipt_repo, device_repo = _wire(
        handler, monkeypatch,
        pending=[("r1", "tok1"), ("r2", "tok2")],
        receipts={"r1": {"status": "ok"}})

    out = handler.lambda_handler({}, None)

    assert receipt_repo.deleted == ["r1"]        # r2 untouched
    assert out == {"pending": 2, "ok": 1, "pruned": 0, "failed": 0}


def test_empty_pending_makes_no_expo_call(handler, monkeypatch):
    receipt_repo = _FakeReceiptRepo([])
    calls = []
    monkeypatch.setattr(handler, "PushReceiptRepository", lambda: receipt_repo)
    monkeypatch.setattr(handler, "DeviceRepository", lambda: _FakeDeviceRepo())
    monkeypatch.setattr(handler, "get_access_token", lambda: "token")
    monkeypatch.setattr(handler, "get_receipts",
                        lambda ids, access_token=None: calls.append(ids) or {})

    out = handler.lambda_handler({}, None)

    assert calls == []                           # never polled Expo
    assert out == _ZERO


def test_non_dict_receipt_is_treated_as_a_failure(handler, monkeypatch, caplog):
    # A malformed (non-dict) receipt can't be interpreted → logged + cleared, not left.
    receipt_repo, device_repo = _wire(
        handler, monkeypatch,
        pending=[("r1", "tok1")], receipts={"r1": "garbage"})

    with caplog.at_level(logging.ERROR):
        out = handler.lambda_handler({}, None)

    assert "PUSH_DELIVERY_FAILED" in caplog.text
    assert receipt_repo.deleted == ["r1"]
    assert out == {"pending": 1, "ok": 0, "pruned": 0, "failed": 1}


def test_dnr_for_an_unknown_id_deletes_without_pruning(handler, monkeypatch):
    # Defensive: an id Expo returns that we never tracked has no token to prune, but the
    # row is still cleared. Guards the `if token` check in the DNR branch.
    receipt_repo, device_repo = _wire(
        handler, monkeypatch,
        pending=[("r1", "tok1")],
        receipts={"ghost": {"status": "error", "details": {"error": "DeviceNotRegistered"}}})

    out = handler.lambda_handler({}, None)

    assert device_repo.removed == []             # no token → nothing pruned
    assert receipt_repo.deleted == ["ghost"]     # still cleared
    assert out == {"pending": 1, "ok": 0, "pruned": 1, "failed": 0}


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
