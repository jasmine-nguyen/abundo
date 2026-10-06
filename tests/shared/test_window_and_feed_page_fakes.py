"""WHIT-768: window-keyed and per-account-pages stand-ins; the alert, insights,
chat-standing, per-account and feed suites keep no local copies."""

from test_repo_fakes_by_behaviour import _PENDING_TRANSACTION_COPIES, _TESTS, _local_copies


def test_window_keyed_and_account_pages_stand_ins_serve_and_record_reads():
    from _transaction_range_fakes import _AccountPagesTransactionRepo, _WindowKeyedTransactionRepo

    july = ("2026-07-01", "2026-07-31")
    by_window = {july: [{"transaction_id": "groceries", "amount": "12.50"}]}
    windowed = _WindowKeyedTransactionRepo(by_window)
    page, cursor = windowed.get_transactions_by_date_range("up-spending", *july)
    assert page == [{"transaction_id": "groceries", "amount": "12.50"}]
    assert cursor is None
    page[0]["transaction_id"] = "changed"
    assert by_window[july][0]["transaction_id"] == "groceries"
    assert windowed.get_transactions_by_date_range("up-saver", *july) == ([], None)
    assert windowed.get_transactions_by_date_range("up-spending", "2026-06-01", "2026-06-30") == ([], None)
    assert windowed.calls == [
        ("up-spending", "2026-07-01", "2026-07-31", 20, None),
        ("up-saver", "2026-07-01", "2026-07-31", 20, None),
        ("up-spending", "2026-06-01", "2026-06-30", 20, None),
    ]

    seed = {"up-spending": [
        ([{"transaction_id": "p1", "pk": "ACCOUNT#up-spending"}], "c1"),
        ([{"transaction_id": "p2"}], None),
    ]}
    pages = _AccountPagesTransactionRepo(seed)
    first, cursor = pages.get_transactions_by_date_range("up-spending", *july, limit=100)
    assert first == [{"transaction_id": "p1", "pk": "ACCOUNT#up-spending"}]
    assert cursor == "c1"
    first[0].pop("pk")
    assert seed["up-spending"][0][0][0]["pk"] == "ACCOUNT#up-spending"
    assert pages.get_transactions_by_date_range("up-spending", *july, limit=100, cursor="c1") == (
        [{"transaction_id": "p2"}], None)
    assert pages.get_transactions_by_date_range("up-spending", *july) == ([], None)
    assert pages.get_transactions_by_date_range("anz-rewards-black-visa", *july) == ([], None)
    assert pages.calls[1] == ("up-spending", "2026-07-01", "2026-07-31", 100, "c1")
    assert len(pages.calls) == 4
    assert _AccountPagesTransactionRepo().get_transactions_by_date_range("x", *july) == ([], None)


_MOVED_BY_WHIT_768 = [
    "lambda/test_budget_alerts.py",
    "lambda/test_budget_alerts_plan_qa.py",
    "lambda/test_budget_alerts_standing_qa.py",
    "lambda/test_budget_alerts_window_read_qa.py",
    "lambda/test_reconcile_merchant_match.py",
    "lambda/test_whit329_qa.py",
    "lambda_api/test_ai_chat_budget_standing_qa.py",
    "lambda_api/test_budget_standing_callers_qa.py",
    "lambda_api/test_budget_excluded_rollups.py",
    "lambda_api/test_category_transactions.py",
    "lambda_api/test_cycle_transactions_qa.py",
    "lambda_api/test_handler.py",
    "lambda_api/test_insights_ai.py",
    "lambda_api/test_shortfall_seam.py",
    "lambda_api/test_transactions_feed.py",
]

_LEFT_FOR_WHIT_769 = {
    "balance_poller/test_feed_stall.py": {"_FakeTransactionRepo"},
    "balance_poller/test_feed_stall_read_bounds_qa.py": {"_Recorder"},
    "balance_poller/test_repayment_miss.py": {"_FakeTxnRepo"},
    "balance_poller/test_repayment_miss_precise.py": {"_FakeTxnRepo"},
    "lambda/test_budget_alerts.py": {"_CursorWindowRepo", "ExplodingWindowRepo", "_NeverEnds"},
    "lambda_api/test_repayment.py": {"FakeTransactionRepo"},
    "lambda_api/test_uncategorized_count.py": {"_NeverEndsRepo"},
    "lambda_api/test_uncategorized_merchants.py": {"_NeverEndsRepo"},
    "lambda_api/test_uncategorized_merchants_gaps.py": {"_FailsOnSecondPage"},
    "lambda_api/test_windowed_read_routes_qa.py": {"_EndlessRepo", "_TwoPagesPerAccountRepo"},
    "shared/test_read_date_range_pages_qa.py": {"_PagedRepo", "_Endless", "_Repo"},
    "shared/test_repository_transaction.py": {"_EndlessRepo"},
}


def test_moved_suites_keep_no_transaction_copies_and_only_whit_769_entries_stay_pending():
    assert _PENDING_TRANSACTION_COPIES == _LEFT_FOR_WHIT_769

    leftovers = []
    for relative in _MOVED_BY_WHIT_768:
        still_pending = _LEFT_FOR_WHIT_769.get(relative, set())
        for lineno, name in _local_copies((_TESTS / relative).read_text()):
            if name not in still_pending:
                leftovers.append(f"{relative}:{lineno} class {name}")
    assert not leftovers, "\n".join(leftovers)
