"""Shared constants + helpers for the pending-mirror suites in tests/sync_trigger (WHIT-784).

The fixtures (layer / repo / mirror / pending_carry / row) live in tests/sync_trigger/conftest.py;
this module holds the plain helpers, which conftest can't export under importlib mode. Leading
underscore keeps pytest from collecting it; ``pythonpath = tests/shared`` makes it importable.
"""

import copy
from datetime import date
from decimal import Decimal

WESTPAC_AID = "A3AC9195-9E8D-48B8-86D0-46D130D7F64A"
UP_AID = "3zVQJ8Btz_IRmqp78VrQnQ"
WESTPAC_SOURCE = {"bid": "fiskil_77", "aid": WESTPAC_AID}
WESTPAC = "westpac-altitude-qantas-black"
UP = "up-spending"
MIRROR_TODAY = date(2026, 9, 29)  # check window starts 22 Sep; the carry read starts 19 Sep
REISSUE_TODAY = date(2026, 10, 1)
REISSUE_BANK_DAY = "2026-09-30"

CETTIRE_OLD = "Pending - Cettire          "
CETTIRE_NEW = "PENDING - Cettire           "
RUSH_OLD = "Pending - SP RUSHFASTERAU"
RUSH_NEW = "PENDING - SP RUSHFASTERAU"
GOGI_OLD = "Pending - GOGI MATCHA"
GOGI_NEW = "PENDING - GOGI MATCHA"
MYKI_OLD = "Pending - myki"
MYKI_NEW = "PENDING - myki"

GUZMAN = {"amount": Decimal("-23.50"), "merchant_name": "Guzman y Gomez", "description": "GUZMAN Y GOMEZ NEWTOWN"}


def pending_row(transaction_id, day="2026-09-28", status="pending", account_id=WESTPAC, **fields):
    return {
        "pk": f"ACCOUNT#{account_id}",
        "sk": f"TXN#{transaction_id}",
        "transaction_id": transaction_id,
        "account_id": account_id,
        "date": day,
        "amount": Decimal("-10.00"),
        "description": f"SHOP {transaction_id}",
        "status": status,
        "category": "Unfiled",
        **fields,
    }


def bank_rows(*ids, aid=WESTPAC_AID, day="2026-09-28", pending=True):
    return [{"id": transaction_id, "accountId": aid, "pending": pending, "date": day}
            for transaction_id in ids]


def reissue_bank_rows(*ids, pending=True):
    return bank_rows(*ids, day=REISSUE_BANK_DAY, pending=pending)


def fetch_returning(rows, before_return=None):
    def fetch(*args):
        if before_return is not None:
            before_return()
        return copy.deepcopy(rows)
    return fetch


def stored_ids(repo):
    return {key[1].removeprefix("TXN#") for key in repo._table.store if key[0].startswith("ACCOUNT#")}


def stored(repo, transaction_id, account_id=WESTPAC):
    return repo._table.store[(f"ACCOUNT#{account_id}", f"TXN#{transaction_id}")]


def unfiled_except(*taxonomy):
    """The taxonomy check: a category is unfiled unless it's one of `taxonomy`."""
    return lambda category: category not in taxonomy


def run_reissue(mirror, repo, bank, is_unfiled, before_return=None):
    return mirror.mirror_account(
        repo, fetch_returning(bank, before_return), WESTPAC_SOURCE, REISSUE_TODAY, is_unfiled
    )
