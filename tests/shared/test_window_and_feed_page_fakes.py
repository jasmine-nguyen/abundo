"""WHIT-768: the window-keyed and per-account-pages stand-ins serve and record reads."""


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
