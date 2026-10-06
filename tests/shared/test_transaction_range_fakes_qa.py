"""WHIT-768 QA: the window-keyed and per-account-pages stand-ins under the real reads."""

from _transaction_range_fakes import _AccountPagesTransactionRepo, _WindowKeyedTransactionRepo


def test_window_keyed_stand_in_serves_a_window_once_through_read_window(shared):
    # [A1] read_window walks every mapped account → the window's rows arrive once, not per account.
    from constants import ACCOUNT_ID_MAP
    from repository_transaction import read_window

    july = ("2026-07-01", "2026-07-31")
    repo = _WindowKeyedTransactionRepo({july: [{"transaction_id": "rent"}, {"transaction_id": "coffee"}]})
    rows = read_window(repo, *july)
    assert [row["transaction_id"] for row in rows] == ["rent", "coffee"]
    assert [c[0] for c in repo.calls] == list(ACCOUNT_ID_MAP.values())


def test_window_keyed_stand_in_locks_the_first_account_even_when_its_window_is_empty():
    # [A2] the first account asked is the only one ever served, whatever window it asked for.
    july = ("2026-07-01", "2026-07-31")
    repo = _WindowKeyedTransactionRepo({july: [{"transaction_id": "rent"}]})
    assert repo.get_transactions_by_date_range("up-spending", "2026-06-01", "2026-06-30") == ([], None)
    assert repo.get_transactions_by_date_range("up-saver", *july) == ([], None)
    assert repo.get_transactions_by_date_range("up-spending", *july) == ([{"transaction_id": "rent"}], None)


def test_account_pages_stand_in_leaves_the_seed_queues_whole():
    # [A3] draining one stand-in doesn't empty the seed, so a second one built from it serves the same pages.
    seed = {"up-spending": [([{"transaction_id": "s1"}], "c1"), ([{"transaction_id": "s2"}], None)]}
    first = _AccountPagesTransactionRepo(seed)
    first.get_transactions_by_date_range("up-spending", "2026-07-01", "2026-07-31")
    first.get_transactions_by_date_range("up-spending", "2026-07-01", "2026-07-31", cursor="c1")
    assert len(seed["up-spending"]) == 2
    second = _AccountPagesTransactionRepo(seed)
    assert second.get_transactions_by_date_range("up-spending", "2026-07-01", "2026-07-31") == (
        [{"transaction_id": "s1"}], "c1")
