"""WHIT-662 regression: pendings the bank no longer lists must be removed.

Replays the 29 Sep 2026 Westpac Altitude check: BankSync's full list lacks three
pendings we still store (the re-worded Costco / Talad Thai "Pending -" copies and
the myki $1 tap-on hold). The hourly mirror must delete exactly those three and
leave every other row alone. It runs the REAL shared TransactionRepository over
the in-memory FakeTable. A second test pins the real call site: the scheduled
sync-trigger handler runs the mirror.
"""

import copy
import importlib
import json
import pathlib
import sys
from datetime import date
from decimal import Decimal

import pytest

from _boto_stubs import install_import_satisfiers, use_condition_fields
from _dynamo_fakes import FakeTable

install_import_satisfiers(ssm_default="test-api-key")

WESTPAC_BID = "fiskil_77"
WESTPAC_AID = "A3AC9195-9E8D-48B8-86D0-46D130D7F64A"
WESTPAC = "westpac-altitude-qantas-black"
UP = "up-spending"
TODAY = date(2026, 9, 29)

DROPPED_IDS = {
    "bank_tx_e937046f0001",  # 28 Sep Costco -195.26 "Pending - ..." copy
    "bank_tx_4fa44d040001",  # 27 Sep Talad Thai -65.45 "Pending - ..." copy
    "bank_tx_33e1f5790001",  # 24 Sep myki tap-on hold -1.00
}


def _row(transaction_id, day, amount, description, status, account_id=WESTPAC):
    return {
        "pk": f"ACCOUNT#{account_id}",
        "sk": f"TXN#{transaction_id}",
        "transaction_id": transaction_id,
        "account_id": account_id,
        "date": day,
        "amount": Decimal(amount),
        "description": description,
        "status": status,
        "category": "Unfiled",
    }


# Rows the bank still lists.
KEPT_ROWS = [
    _row("bank_tx_costco_posted", "2026-09-28", "-195.26", "COSTCO WHOLESALE DOCKLANDS", "posted"),
    _row("bank_tx_talad_posted", "2026-09-27", "-65.45", "TALAD THAI MELBOURNE", "posted"),
    _row("bank_tx_myki_fare", "2026-09-25", "-5.70", "MYKI TRANSPORT FARE", "posted"),
    _row("bank_tx_coles_pending", "2026-09-28", "-42.10", "PENDING - COLES 0412", "pending"),
    _row("bank_tx_woolies_posted", "2026-09-23", "-88.00", "WOOLWORTHS 3321", "posted"),
    _row("bank_tx_uber_pending", "2026-09-29", "-18.40", "PENDING - UBER *TRIP", "pending"),
]

DROPPED_ROWS = [
    _row("bank_tx_e937046f0001", "2026-09-28", "-195.26", "Pending - COSTCO WHOLESALE DOCKLANDS", "pending"),
    _row("bank_tx_4fa44d040001", "2026-09-27", "-65.45", "Pending - TALAD THAI MELBOURNE", "pending"),
    _row("bank_tx_33e1f5790001", "2026-09-24", "-1.00", "MYKI TAP ON", "pending"),
]

# Rows the mirror must never touch on this account's run.
UNTOUCHABLE_ROWS = [
    # A posted row the bank no longer lists: posted rows are never deleted.
    _row("bank_tx_posted_gone", "2026-09-26", "-12.00", "OLD POSTED", "posted"),
    # A pending before the check window (today - FEED_WINDOW_DAYS): left to age-out.
    _row("bank_tx_old_pending", "2026-09-10", "-9.99", "PENDING - OLD", "pending"),
    # Another account's pending: not this account's business.
    _row("up_tx_pending", "2026-09-28", "-7.50", "UP PENDING", "pending", account_id=UP),
]


def _bank_row(row):
    return {
        "id": row["transaction_id"],
        "accountId": WESTPAC_AID,
        "pending": row["status"] == "pending",
        "date": row["date"],
        "authorizedDate": row["date"],
        "amount": float(row["amount"]),
        "description": row["description"],
    }


BANK_LIST = [_bank_row(row) for row in KEPT_ROWS]

_SHARED_DIR = str(pathlib.Path(__file__).resolve().parents[2] / "shared")
_SHARED_MODULES = {path.stem for path in pathlib.Path(_SHARED_DIR).glob("*.py")} - {"ssm"}


@pytest.fixture
def layer():
    """The real shared repository + pending_mirror, imported over the condition-recording
    boto fakes so FakeTable can evaluate their queries and conditional deletes."""
    with use_condition_fields():
        sys.path.insert(0, _SHARED_DIR)
        saved = {name: sys.modules.pop(name, None) for name in _SHARED_MODULES | {"pending_mirror"}}
        try:
            yield importlib.import_module("repository_transaction")
        finally:
            for name, module in saved.items():
                sys.modules.pop(name, None)
                if module is not None:
                    sys.modules[name] = module
            sys.path.remove(_SHARED_DIR)


def test_29_sep_replay_removes_exactly_the_three_dropped_pendings(layer):
    pending_mirror = importlib.import_module("pending_mirror")
    repo = layer.TransactionRepository()
    repo._table = FakeTable()
    repo._table.seed(*(KEPT_ROWS + DROPPED_ROWS + UNTOUCHABLE_ROWS))
    before = copy.deepcopy(repo._table.store)

    def fetch(*args, **kwargs):
        return copy.deepcopy(BANK_LIST)

    source = {"bid": WESTPAC_BID, "aid": WESTPAC_AID}
    result = pending_mirror.mirror_account(repo, fetch, source, TODAY, lambda row: False)

    removed = {key[1].removeprefix("TXN#") for key in set(before) - set(repo._table.store)}
    assert removed == DROPPED_IDS
    for key, item in repo._table.store.items():
        assert item == before[key]
    assert result["removed"] == 3
    assert result["skipped"] is None


class _FakeResponse:
    def __init__(self, payload):
        self._body = json.dumps(payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self._body


def test_scheduled_sync_trigger_runs_the_pending_mirror(monkeypatch):
    import handler

    monkeypatch.setattr(handler, "get_api_key", lambda: "the-key")
    monkeypatch.setattr(
        handler.urllib.request,
        "urlopen",
        lambda req, timeout=None: _FakeResponse({"data": {"id": "job-1"}}),
    )
    calls = []
    monkeypatch.setattr(
        handler.pending_mirror, "mirror_pendings", lambda api_key, *a, **k: calls.append(api_key)
    )

    handler.lambda_handler({}, None)

    assert calls == ["the-key"]
