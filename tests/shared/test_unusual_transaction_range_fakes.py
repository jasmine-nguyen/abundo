"""WHIT-769: the shared never-ending, fail-on-purpose and page-by-page transaction
stand-ins serve and record reads, and no test file keeps its own copy any more."""

import pytest

import test_repo_fakes_by_behaviour as guard
import _transaction_range_fakes as fakes


def test_unusual_situation_transaction_stand_ins_serve_and_record_reads():
    seed = [{"transaction_id": "unfiled", "date": "2026-07-02", "category": None}]
    endless = fakes._EndlessTransactionRepo(page=seed)
    for _ in range(3):
        page, cursor = endless.get_transactions_by_date_range("up-spending", "2026-07-01", "2026-07-31", 100, None)
        assert page == [{"transaction_id": "unfiled", "date": "2026-07-02", "category": None}]
        assert cursor
        page[0]["category"] = "changed"
    assert seed[0]["category"] is None
    assert len(endless.calls) == 3
    assert endless.calls[0] == ("up-spending", "2026-07-01", "2026-07-31", 100, None)
    assert fakes._EndlessTransactionRepo().get_transactions_by_date_range("a", "s", "e")[0] == []

    boom = RuntimeError("dynamodb unavailable")
    failing = fakes._FailingTransactionRepo(boom, pages=[([{"transaction_id": "c1"}], {"pk": "ACC", "sk": "TXN#c1"})])
    assert failing.get_transactions_by_date_range("acc", "2026-07-01", "2026-07-31") == (
        [{"transaction_id": "c1"}], {"pk": "ACC", "sk": "TXN#c1"})
    with pytest.raises(RuntimeError) as raised:
        failing.get_transactions_by_date_range("acc", "2026-07-01", "2026-07-31", 50, {"pk": "ACC", "sk": "TXN#c1"})
    assert raised.value is boom
    assert failing.calls == [
        ("acc", "2026-07-01", "2026-07-31", 20, None),
        ("acc", "2026-07-01", "2026-07-31", 50, {"pk": "ACC", "sk": "TXN#c1"}),
    ]
    with pytest.raises(AssertionError, match="must not read"):
        fakes._FailingTransactionRepo(AssertionError("must not read the window")).get_transactions_by_date_range(
            "acc", "2026-07-01", "2026-07-31")

    rows = {
        "acc": [
            {"transaction_id": "old", "date": "2026-06-30"},
            {"transaction_id": "t1", "date": "2026-07-01"},
            {"transaction_id": "t2", "date": "2026-07-05"},
            {"transaction_id": "t3", "date": "2026-07-09"},
        ],
        "other": [{"transaction_id": "o1", "date": "2026-07-03"}],
    }
    store = fakes._PagedStoreTransactionRepo(rows, page_size=2)
    page, cursor = store.get_transactions_by_date_range("acc", "2026-07-01", None)
    assert [t["transaction_id"] for t in page] == ["t1", "t2"]
    assert cursor == 2
    page[0]["transaction_id"] = "edited"
    page, cursor = store.get_transactions_by_date_range("acc", "2026-07-01", None, 20, 2)
    assert [t["transaction_id"] for t in page] == ["t3"]
    assert cursor is None
    assert rows["acc"][1]["transaction_id"] == "t1"
    assert store.get_transactions_by_date_range("acc", "2026-07-01", "2026-07-05") == (
        [{"transaction_id": "t1", "date": "2026-07-01"}, {"transaction_id": "t2", "date": "2026-07-05"}], None)
    store.rows_by_account["other"].append({"transaction_id": "o2", "date": "2026-07-04"})
    page, cursor = store.get_transactions_by_date_range("other", "2026-07-01", None)
    assert [t["transaction_id"] for t in page] == ["o1", "o2"]
    assert cursor is None
    assert store.get_transactions_by_date_range("missing", "2026-07-01", None) == ([], None)
    assert store.calls[1] == ("acc", "2026-07-01", None, 20, 2)
    assert len(store.calls) == 5
    assert fakes._PagedStoreTransactionRepo().rows_by_account == {}


def test_no_test_file_keeps_a_pending_transaction_read_copy():
    assert not hasattr(guard, "_PENDING_TRANSACTION_COPIES")
    copies = []
    for path in sorted(guard._TESTS.rglob("*.py")):
        relative = path.relative_to(guard._TESTS).as_posix()
        if guard._is_shared_fake_module(relative):
            continue
        allowed = guard._ALLOWED.get(relative, set())
        copies += [f"{relative}:{lineno} class {name}"
                   for lineno, name in guard._local_copies(path.read_text()) if name not in allowed]
    assert not copies, "move these onto tests/shared/_transaction_range_fakes.py:\n" + "\n".join(copies)
