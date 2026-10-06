"""Shared stand-ins for ``get_transactions_by_date_range`` (WHIT-767).

Each records ``self.calls`` as ``(account_id, start, end, limit, cursor)``. On the
pytest path via ``pythonpath = tests/shared`` (pytest.ini).
"""


class _DateFilteringTransactionRepo:
    """Inclusive date filter like DynamoDB `between`, served once (then empty), as copies."""

    def __init__(self, transactions):
        self._transactions = list(transactions)
        self._served = False
        self.calls = []

    def get_transactions_by_date_range(self, account_id, start_date, end_date, limit=20, cursor=None):
        self.calls.append((account_id, start_date, end_date, limit, cursor))
        if self._served:
            return [], None
        self._served = True
        return [dict(t) for t in self._transactions if start_date <= t["date"] <= end_date], None


class _QueuedTransactionRepo:
    """Ignores the arguments and serves queued (items, cursor) pages, then ([], None)."""

    def __init__(self, transactions=None, pages=None):
        if pages is None:
            pages = [(list(transactions or []), None)]
        self._pages = list(pages)
        self.calls = []

    def get_transactions_by_date_range(self, account_id, start_date, end_date, limit=20, cursor=None):
        self.calls.append((account_id, start_date, end_date, limit, cursor))
        if not self._pages:
            return [], None
        return self._pages.pop(0)


class _AccountTransactionRepo:
    """Serves copies of the rows on the asked account whose date is inside the bounds."""

    def __init__(self, rows):
        self._rows = list(rows)
        self.calls = []

    def get_transactions_by_date_range(self, account_id, start_date, end_date, limit=20, cursor=None):
        self.calls.append((account_id, start_date, end_date, limit, cursor))
        page = [dict(row) for row in self._rows
                if row["account_id"] == account_id and start_date <= row["date"] <= end_date]
        return page, None
