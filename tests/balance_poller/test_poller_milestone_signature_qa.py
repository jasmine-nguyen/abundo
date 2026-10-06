"""WHIT-764 QA: the poller's one production call still satisfies notify_milestone_crossing's
signature now that `milestone_repo` is a required keyword.

The other poller tests swap the detector for a catch-all lambda, so a call missing a required
keyword (or passing one the detector doesn't take) would still pass them. This binds the
captured call against the REAL signature.
"""

import inspect
from decimal import Decimal


class _FakeBalanceRepo:
    def get_balance(self, account_id):
        return {"balance": Decimal("600000"), "as_of": "x", "currency": "AUD"}

    def upsert_balance(self, account_id, balance, as_of, currency):
        pass


_OK_PAYLOAD = {
    "success": True,
    "data": {
        "date": "2026-07-04T00:24:37.614Z", "accountName": "Home loan",
        "accountType": "mortgage", "accountId": "T6d8ppsYssBDFCwl1qEb0w",
        "bankId": "fiskil_3", "amount": -596642.43, "currency": "AUD",
    },
}


# [A1] the poller's call binds to the real, required-keyword signature
def test_poller_call_binds_to_the_real_detector_signature(handler, monkeypatch):
    real_signature = inspect.signature(handler.notify_milestone_crossing)
    monkeypatch.setattr(handler, "HomeLoanBalanceRepository", _FakeBalanceRepo)
    monkeypatch.setattr(handler, "fetch_balance", lambda *a, **k: _OK_PAYLOAD)
    calls = []
    monkeypatch.setattr(handler, "notify_milestone_crossing",
                        lambda *args, **kwargs: calls.append((args, kwargs)) or 0)

    assert handler._poll_homeloan("key") is True
    assert len(calls) == 1
    args, kwargs = calls[0]
    bound = real_signature.bind(*args, **kwargs)
    assert bound.arguments["old_balance"] == Decimal("600000")
    assert isinstance(bound.arguments["milestone_repo"], handler.MilestoneRepository)
