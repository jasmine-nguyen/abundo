"""Shared fakes for the GET /transactions/feed suites.

Two suites need the same realistic date-index feed fake: the impl suite
tests/lambda_api/test_transactions_feed.py and its adversarial gap suite
test_transactions_feed_gaps.py. They live here, in ONE definition, so both `import`
them instead of copying FakeFeedRepo (a copy drifts, and the multi-page no-dupe/no-gap
assertions only mean anything while the fake models DynamoDB's resume-strictly-after
ExclusiveStartKey exactly — WHIT-445).

Resolved by pytest.ini's `pythonpath = tests/shared`, the same way the category suites
import `_category_fakes`. This module is dependency-light (stdlib `copy` only), so it
imports with no shared/-layer module on the path and needs no conftest `_REIMPORT` entry.
"""

import copy

# The three internal account ids, in ACCOUNT_ID_MAP order.
ANZ = "anz-rewards-black-visa"
SPENDING = "up-spending"
HOMELOAN = "up-homeloan"


def _row(account_id, date, txn_id, **extra):
    """A stored transaction row as the date-index query returns it (with pk/sk)."""
    return {
        "pk": f"ACCOUNT#{account_id}", "sk": f"TXN#{txn_id}",
        "transaction_id": txn_id, "account_id": account_id, "date": date, **extra,
    }


class FakeFeedRepo:
    """Realistic stand-in modelling a date-index newest-first query with ExclusiveStartKey.

    Holds each account's rows sorted newest-first (date desc, sk desc as the intra-date
    tiebreak, mirroring how DynamoDB disambiguates equal sort-key values by the base key)
    and resumes STRICTLY AFTER the row a cursor names. Returns a LastEvaluatedKey only when
    genuine rows remain past the page, and hands out deep copies (the handler mutates rows
    in place: pop pk/sk, setdefault category)."""

    def __init__(self, rows_by_account):
        self._rows = {
            account_id: sorted(rows, key=lambda r: (r["date"], r["sk"]), reverse=True)
            for account_id, rows in rows_by_account.items()
        }
        self.calls = []

    @staticmethod
    def _key(row):
        return {
            "account_id": row["account_id"], "date": row["date"],
            "pk": row["pk"], "sk": row["sk"],
        }

    def get_transactions_by_date_range(
        self, account_id, start_date, end_date, limit=20, cursor=None
    ):
        self.calls.append((account_id, start_date, end_date, limit, cursor))
        rows = self._rows.get(account_id, [])
        start = 0
        if cursor is not None:
            for index, row in enumerate(rows):
                if row["pk"] == cursor["pk"] and row["sk"] == cursor["sk"]:
                    start = index + 1
                    break
        page = rows[start:start + limit]
        has_more = (start + limit) < len(rows) and bool(page)
        next_key = self._key(page[-1]) if has_more else None
        return copy.deepcopy(page), next_key


def _feed_event(params=None):
    return {
        "rawPath": "/transactions/feed",
        "requestContext": {"http": {"method": "GET"}},
        "queryStringParameters": params,
    }
