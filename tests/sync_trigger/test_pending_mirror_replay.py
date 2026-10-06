"""WHIT-662 regression: pendings the bank no longer lists must be removed.

Replays the 29 Sep 2026 Westpac Altitude check: BankSync's full list lacks three
pendings we still store (the re-worded Costco / Talad Thai "Pending -" copies and
the myki $1 tap-on hold). The hourly mirror must delete exactly those three and
leave every other row alone. It runs the REAL shared TransactionRepository over
the in-memory FakeTable. A second test pins the real call site: the scheduled
sync-trigger handler runs the mirror.
"""

import copy
from decimal import Decimal

from _http_fakes import FakeResponse
from _pending_mirror_fakes import MIRROR_TODAY, UP, WESTPAC, WESTPAC_AID, WESTPAC_SOURCE

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

def test_29_sep_replay_removes_exactly_the_three_dropped_pendings(repo, mirror):
    repo._table.seed(*(KEPT_ROWS + DROPPED_ROWS + UNTOUCHABLE_ROWS))
    before = copy.deepcopy(repo._table.store)

    def fetch(*args, **kwargs):
        return copy.deepcopy(BANK_LIST)

    result = mirror.mirror_account(repo, fetch, WESTPAC_SOURCE, MIRROR_TODAY, lambda category: True)

    removed = {key[1].removeprefix("TXN#") for key in set(before) - set(repo._table.store)}
    assert removed == DROPPED_IDS
    for key, item in repo._table.store.items():
        assert item == before[key]
    assert result["removed"] == 3
    assert result["skipped"] is None


def test_scheduled_sync_trigger_runs_the_pending_mirror(monkeypatch):
    import handler

    monkeypatch.setattr(handler, "get_api_key", lambda: "the-key")
    monkeypatch.setattr(
        handler.urllib.request,
        "urlopen",
        lambda req, timeout=None: FakeResponse({"data": {"id": "job-1"}}),
    )
    calls = []
    monkeypatch.setattr(
        handler.pending_mirror, "mirror_pendings", lambda api_key, *a, **k: calls.append(api_key)
    )

    handler.lambda_handler({}, None)

    assert calls == ["the-key"]
