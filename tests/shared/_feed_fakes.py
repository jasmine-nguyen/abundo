"""Shared fakes for the GET /transactions/feed suites.

Two suites need the same realistic date-index feed fake: the impl suite
tests/lambda_api/test_transactions_feed.py and its adversarial gap suite
test_transactions_feed_gaps.py. They live here, in ONE definition, so both `import`
them instead of copying FakeFeedRepo (a copy drifts, and the multi-page no-dupe/no-gap
assertions only mean anything while the fake models DynamoDB's resume-strictly-after
ExclusiveStartKey exactly — WHIT-445).

Resolved by pytest.ini's `pythonpath = tests/shared`, the same way the category suites
import `_category_fakes`. This module imports nothing from the shared layer at MODULE scope
(stdlib `copy` only), so it imports with no shared/-layer module on the path and needs no
conftest `_REIMPORT` entry. WritableFeedRepo's one shared import is deferred into the method
body to keep that true — see [G2].
"""

import copy

# The internal account ids, in ACCOUNT_ID_MAP order.
ANZ = "anz-rewards-black-visa"
SPENDING = "up-spending"
HOMELOAN = "up-homeloan"
WESTPAC = "westpac-altitude-qantas-black"


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


class WritableFeedRepo(FakeFeedRepo):
    """FakeFeedRepo plus the conditional category write, so a second run really sees the first
    run's effect. Promoted here in WHIT-508 — test_apply_rules.py and test_apply_rules_gaps.py
    each carried a byte-identical private copy, which is exactly the drift this module prevents.

    The conditional is implemented for REAL against the fake's own rows rather than keyed off an
    id set, so the fake cannot lie: a handler that passed the wrong expected value (the rule's
    target instead of the value the scan saw) fails here.

      error_ids    — raise DatabaseError (a retryable database failure).
      vanished_ids — the row was deleted between the scan and the write.
      refile_hook  — called once before each write with (transaction_id, repo), so a test can
                     simulate the user tapping a category mid-run.
      scan_shows   — transaction_id -> the category the SCAN reports, while the store holds the
                     real one. The scan reads a secondary index that cannot be read consistently,
                     so "the scan is behind the stored row" is the everyday case, not an exotic one.
    """

    def __init__(self, rows_by_account):
        super().__init__(rows_by_account)
        self.writes = []
        self.vanished_ids = set()
        self.error_ids = set()
        self.refile_hook = None
        self.scan_shows = {}

    def get_transactions_by_date_range(self, account_id, start_date, end_date, limit=20, cursor=None):
        page, next_key = super().get_transactions_by_date_range(
            account_id, start_date, end_date, limit, cursor)
        for row in page:
            transaction_id = row["sk"].split("#", 1)[1]
            if transaction_id in self.scan_shows:
                row["category"] = self.scan_shows[transaction_id]
        return page, next_key

    def _find_row(self, pk, sk):
        """Resolve a row by its FULL key. Matching on sk alone would silently cross accounts —
        ids like "t1" repeat per account in these fixtures, so a multi-account test would write
        to the wrong row and still look green."""
        for rows in self._rows.values():
            for row in rows:
                if row["pk"] == pk and row["sk"] == sk:
                    return row
        return None

    def set_category(self, transaction_id, category, account_id=SPENDING):
        """Write a category behind the handler's back — the user's tap, mid-run."""
        row = self._find_row(f"ACCOUNT#{account_id}", f"TXN#{transaction_id}")
        if row is None:
            raise AssertionError(f"no row {transaction_id!r} in account {account_id!r}")
        row["category"] = category

    def update_transaction_category_if_unchanged(self, pk, sk, category, expected_category):
        transaction_id = sk.split("#", 1)[1]
        if self.refile_hook is not None:
            self.refile_hook(transaction_id, self)
        self.writes.append((pk, sk, category, expected_category))
        if transaction_id in self.error_ids:
            # Imported lazily: _feed_fakes must stay importable with no shared/ layer on the
            # path ([G2]), so this may not move to module scope.
            from repository import DatabaseError
            raise DatabaseError("write failed")
        if transaction_id in self.vanished_ids:
            return "gone", None
        row = self._find_row(pk, sk)
        if row is None:
            return "gone", None
        if row.get("category") != expected_category:
            return "changed", row.get("category")
        row["category"] = category
        return "written", category
