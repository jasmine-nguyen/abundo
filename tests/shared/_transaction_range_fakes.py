"""Shared stand-ins for ``get_transactions_by_date_range`` (WHIT-767).

Each records ``self.calls`` as ``(account_id, start, end, limit, cursor)``. On the
pytest path via ``pythonpath = tests/shared`` (pytest.ini).
"""

import copy


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
    """Ignores the arguments and serves queued (items, cursor) pages, then ([], None).

    ``pages=`` items are served as given, not copied.
    """

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


class _WindowKeyedTransactionRepo:
    """Serves copies of the (start, end) window's rows to the FIRST account asked only,
    so read_window's account loop doesn't multiply them."""

    def __init__(self, by_window):
        self._by_window = by_window
        self._first_account = None
        self.calls = []

    def get_transactions_by_date_range(self, account_id, start_date, end_date, limit=20, cursor=None):
        self.calls.append((account_id, start_date, end_date, limit, cursor))
        if self._first_account is None:
            self._first_account = account_id
        if account_id != self._first_account:
            return [], None
        return [dict(t) for t in self._by_window.get((start_date, end_date), [])], None


class _AccountPagesTransactionRepo:
    """Serves each account's queued (items, cursor) pages in order, then ([], None).

    Pages are deep copies: callers edit rows in place (pop pk/sk), which must not
    corrupt the seed or a later page.
    """

    def __init__(self, pages_by_account=None):
        self._pages = {account_id: list(pages) for account_id, pages in (pages_by_account or {}).items()}
        self.calls = []

    def get_transactions_by_date_range(self, account_id, start_date, end_date, limit=20, cursor=None):
        self.calls.append((account_id, start_date, end_date, limit, cursor))
        queue = self._pages.get(account_id)
        if not queue:
            return [], None
        items, next_cursor = queue.pop(0)
        return copy.deepcopy(items), next_cursor
