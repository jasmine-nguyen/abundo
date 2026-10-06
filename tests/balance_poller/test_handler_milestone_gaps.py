"""Adversarial GAP tests for the poller's milestone hook (lambda_balance_poller/handler.py).

test_handler.py already proves the detector receives the owed (abs) old/new, gets None on the
first poll, and that a detector exception is swallowed. These gaps pin the wiring around that hook:

  * [WHIT-301] the detector runs ONLY after a SUCCESSFUL upsert — a raising upsert means the
    balance write failed, so no crossing may be celebrated;
  * [WHIT-384] the poller threads a real MilestoneRepository through as milestone_repo, so the
    detector measures against the user's SAVED plan (not the built-in default);
  * [WHIT-369] the poller stays single-tenant — it pins no scope, so both the plan read and the
    fired-state route to the shared owner via the None default.
"""

import inspect
import sys
from decimal import Decimal

from _balance_fakes import balance_repo, upserted
from _http_fakes import FakeResponse

_HOMELOAN_DELTA = {"account_id": "up-homeloan", "old": Decimal("-600000"), "new": Decimal("-596642.43")}


def _capture_detector(monkeypatch):
    """Swap the real detector (behind the home-loan helper) for a recorder of each call."""
    calls = []
    monkeypatch.setattr(sys.modules["milestones"], "notify_milestone_crossing",
                        lambda *args, **kwargs: calls.append((args, kwargs)) or 0)
    return calls


_PRIOR_HOMELOAN = {"account_id": "up-homeloan", "amount": Decimal("-600000"), "available_balance": None,
                   "currency": "AUD", "as_of": "2026-07-03T00:00:00Z", "account_type": "mortgage"}


# WHIT-301 — [A25] fail-on-revert: detector is NOT called when the upsert raises (no store -> no push).

def test_milestone_detector_not_called_when_upsert_fails(handler, monkeypatch):
    repo = balance_repo(rows=[_PRIOR_HOMELOAN], upsert_fails=True)
    monkeypatch.setattr(handler, "get_api_key", lambda: "k")
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: repo)
    monkeypatch.setattr(handler.urllib.request, "urlopen", lambda req, timeout=None: FakeResponse({
        "success": True,
        "data": {"amount": -544000, "date": "2026-07-04T00:00:00Z", "accountType": "mortgage"},
    }))
    called = _capture_detector(monkeypatch)

    assert handler.lambda_handler({}, None)["homeloan_stored"] is False
    assert "up-homeloan" in upserted(repo), "upsert was attempted"
    assert called == [], "the crossing detector must not run when the balance was never stored"


def test_poller_call_binds_to_the_real_detector_signature(handler, monkeypatch):
    # [WHIT-764] Bind the captured call against the REAL signature, so a call missing a required
    # keyword (or passing one the detector doesn't take) fails here. [WHIT-384] The poller threads
    # its own MilestoneRepository through, so the detector reads the saved plan. [WHIT-369] It pins
    # no scope, so the plan and fired-state route to the single shared owner.
    real_signature = inspect.signature(sys.modules["milestones"].notify_milestone_crossing)
    calls = _capture_detector(monkeypatch)

    handler._check_homeloan([_HOMELOAN_DELTA])

    [(args, kwargs)] = calls
    bound = real_signature.bind(*args, **kwargs)
    assert bound.arguments["old_balance"] == Decimal("600000")
    assert isinstance(bound.arguments["milestone_repo"], handler.MilestoneRepository)
    assert "scope" not in bound.arguments
