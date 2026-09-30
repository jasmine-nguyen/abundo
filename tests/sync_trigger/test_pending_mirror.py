"""WHIT-662: the hourly pending mirror — removal rules, skip reasons and the bank-list fetch.

Runs the REAL shared TransactionRepository over the in-memory FakeTable (see the replay test for
the fixture's reasoning). The bank list is faked at the fetch seam, or at urlopen for the fetch.
"""

import copy
import importlib
import io
import json
import pathlib
import sys
import urllib.error
import urllib.parse
from datetime import date
from decimal import Decimal

import pytest

from _boto_stubs import install_import_satisfiers, use_condition_fields
from _dynamo_fakes import FakeTable, _client_error

install_import_satisfiers(ssm_default="test-api-key")

WESTPAC_AID = "A3AC9195-9E8D-48B8-86D0-46D130D7F64A"
UP_AID = "3zVQJ8Btz_IRmqp78VrQnQ"
WESTPAC_SOURCE = {"bid": "fiskil_77", "aid": WESTPAC_AID}
WESTPAC = "westpac-altitude-qantas-black"
UP = "up-spending"
TODAY = date(2026, 9, 29)

_SHARED_DIR = str(pathlib.Path(__file__).resolve().parents[2] / "shared")
_SHARED_MODULES = {path.stem for path in pathlib.Path(_SHARED_DIR).glob("*.py")} - {"ssm"}


@pytest.fixture
def layer():
    """(repository_transaction, pending_mirror), freshly imported over the condition-recording
    boto fakes so FakeTable can evaluate their queries and conditional deletes."""
    with use_condition_fields():
        sys.path.insert(0, _SHARED_DIR)
        saved = {name: sys.modules.pop(name, None) for name in _SHARED_MODULES | {"pending_mirror"}}
        try:
            yield importlib.import_module("repository_transaction"), importlib.import_module("pending_mirror")
        finally:
            for name, module in saved.items():
                sys.modules.pop(name, None)
                if module is not None:
                    sys.modules[name] = module
            sys.path.remove(_SHARED_DIR)


@pytest.fixture
def repo(layer):
    repository_transaction, _ = layer
    repository = repository_transaction.TransactionRepository()
    repository._table = FakeTable()
    return repository


@pytest.fixture
def mirror(layer):
    return layer[1]


def _row(transaction_id, day="2026-09-28", status="pending", account_id=WESTPAC, **fields):
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


def _bank(*ids, aid=WESTPAC_AID):
    return [{"id": transaction_id, "accountId": aid, "pending": True, "date": "2026-09-28"}
            for transaction_id in ids]


def _fetch_returning(rows):
    def fetch(*args):
        return copy.deepcopy(rows)
    return fetch


def _ids(repo):
    return {key[1].removeprefix("TXN#") for key in repo._table.store}


def _never_filed(row):
    return False


# --- mirror_account: what gets removed ---------------------------------------------------------


def test_a_posted_row_missing_from_the_bank_list_is_not_deleted(repo, mirror):
    repo._table.seed(_row("kept"), _row("posted_gone", status="posted"))

    result = mirror.mirror_account(repo, _fetch_returning(_bank("kept")), WESTPAC_SOURCE, TODAY, _never_filed)

    assert _ids(repo) == {"kept", "posted_gone"}
    assert result["removed"] == 0


def test_a_pending_before_the_check_window_is_not_deleted(repo, mirror):
    # Check window starts at today - FEED_WINDOW_DAYS (7) = 22 Sep.
    repo._table.seed(_row("kept"), _row("old", day="2026-09-21"), _row("edge", day="2026-09-22"))

    mirror.mirror_account(repo, _fetch_returning(_bank("kept")), WESTPAC_SOURCE, TODAY, _never_filed)

    assert _ids(repo) == {"kept", "old"}


def test_a_user_edited_pending_is_kept_and_counted(repo, mirror):
    repo._table.seed(_row("kept"), _row("edited", notes="dinner with Sam"))

    result = mirror.mirror_account(
        repo, _fetch_returning(_bank("kept")), WESTPAC_SOURCE, TODAY, lambda row: bool(row.get("notes"))
    )

    assert _ids(repo) == {"kept", "edited"}
    assert result["kept"] == 1
    assert result["removed"] == 0


def test_a_pending_already_settled_or_gone_is_counted_as_gone(repo, mirror):
    repo._table.seed(_row("kept"), _row("settling"))
    # The webhook posts the row between our read and our delete.
    repo._table.before_next_write(lambda key, table: table.store[(key["pk"], key["sk"])].update(status="posted"))

    result = mirror.mirror_account(repo, _fetch_returning(_bank("kept")), WESTPAC_SOURCE, TODAY, _never_filed)

    assert _ids(repo) == {"kept", "settling"}
    assert result["gone"] == 1
    assert result["removed"] == 0


def test_a_failed_delete_does_not_stop_the_others(repo, mirror):
    repo._table.seed(_row("kept"), _row("a"), _row("b"))
    repo._table.fail("delete_item", when=lambda key: key["sk"] == "TXN#a")

    result = mirror.mirror_account(repo, _fetch_returning(_bank("kept")), WESTPAC_SOURCE, TODAY, _never_filed)

    assert _ids(repo) == {"kept", "a"}
    assert result["failed"] == 1
    assert result["removed"] == 1


def test_a_pending_the_bank_lists_as_posted_is_kept(repo, mirror):
    repo._table.seed(_row("kept"), _row("now_posted"))
    bank = _bank("kept") + [{"id": "now_posted", "accountId": WESTPAC_AID, "pending": False}]

    mirror.mirror_account(repo, _fetch_returning(bank), WESTPAC_SOURCE, TODAY, _never_filed)

    assert _ids(repo) == {"kept", "now_posted"}


# --- mirror_account: skips ---------------------------------------------------------------------


def test_an_empty_bank_list_deletes_nothing(repo, mirror):
    repo._table.seed(_row("a"))

    result = mirror.mirror_account(repo, _fetch_returning([]), WESTPAC_SOURCE, TODAY, _never_filed)

    assert _ids(repo) == {"a"}
    assert result["skipped"] == "empty"


def test_more_missing_than_the_cap_deletes_nothing(repo, mirror):
    repo._table.seed(_row("kept"), *(_row(f"missing{n}") for n in range(11)))

    result = mirror.mirror_account(repo, _fetch_returning(_bank("kept")), WESTPAC_SOURCE, TODAY, _never_filed)

    assert len(_ids(repo)) == 12
    assert result["skipped"] == "too_many_removals"


def test_exactly_the_cap_is_still_removed(repo, mirror):
    repo._table.seed(_row("kept"), *(_row(f"missing{n}") for n in range(10)))

    result = mirror.mirror_account(repo, _fetch_returning(_bank("kept")), WESTPAC_SOURCE, TODAY, _never_filed)

    assert _ids(repo) == {"kept"}
    assert result["removed"] == 10


def test_a_fetch_error_propagates_and_deletes_nothing(repo, mirror):
    repo._table.seed(_row("a"))

    def fetch(*args):
        raise mirror.MirrorSkip("success is not true")

    with pytest.raises(mirror.MirrorSkip):
        mirror.mirror_account(repo, fetch, WESTPAC_SOURCE, TODAY, _never_filed)
    assert _ids(repo) == {"a"}


def test_our_rows_are_read_before_the_bank_list_is_fetched(repo, mirror):
    repo._table.seed(_row("kept"))
    calls = []
    original_query = repo._table.query

    def query(**kwargs):
        calls.append("read")
        return original_query(**kwargs)

    repo._table.query = query

    def fetch(*args):
        calls.append("fetch")
        return _bank("kept")

    mirror.mirror_account(repo, fetch, WESTPAC_SOURCE, TODAY, _never_filed)

    assert calls == ["read", "fetch"]


def test_the_fetch_window_reaches_back_past_the_feed_window_to_tomorrow(repo, mirror):
    calls = []

    def fetch(*args):
        calls.append(args)
        return _bank("x")

    mirror.mirror_account(repo, fetch, WESTPAC_SOURCE, TODAY, _never_filed)

    assert calls == [("fiskil_77", WESTPAC_AID, "2026-09-19", "2026-09-30")]


# --- mirror_pendings ----------------------------------------------------------------------------


class _Categories:
    def __init__(self, categories=(), error=None):
        self._categories = list(categories)
        self._error = error

    def list_categories(self):
        if self._error:
            raise self._error
        return list(self._categories)


def _bank_by_account(westpac, up):
    def fetch(bid, aid, api_key, date_from, date_to):
        if aid == WESTPAC_AID:
            if isinstance(westpac, Exception):
                raise westpac
            return copy.deepcopy(westpac)
        return copy.deepcopy(up)
    return fetch


def _http_error(code):
    return urllib.error.HTTPError("https://api.banksync.io/x", code, "boom", None, io.BytesIO(b""))


def test_user_filed_and_rule_filed_pendings(repo, mirror):
    repo._table.seed(
        _row("kept"),
        _row("user_category", category="groceries"),
        _row("rule_category", category="groceries", filed_by_rule="rule-1"),
        _row("noted", notes="x"),
        _row("tagged", tags=["trip"]),
        _row("excluded", budget_excluded=True),
        _row("raw_bank_category", category="FOOD_AND_DRINK"),
    )
    fetch = _bank_by_account(_bank("kept"), _bank("u", aid=UP_AID))

    summary = mirror.mirror_pendings(
        "key", repo=repo, category_repo=_Categories([{"id": "groceries"}]), today=TODAY, fetch=fetch
    )

    assert _ids(repo) == {"kept", "user_category", "noted", "tagged", "excluded"}
    assert summary["removed"] == 2
    assert summary["kept"] == 4


def test_a_category_read_failure_skips_every_account(repo, mirror):
    repo._table.seed(_row("gone"))
    fetch = _bank_by_account(_bank("kept"), _bank("u", aid=UP_AID))

    summary = mirror.mirror_pendings(
        "key", repo=repo, category_repo=_Categories(error=RuntimeError("down")), today=TODAY, fetch=fetch
    )

    assert _ids(repo) == {"gone"}
    assert summary["skipped"] == 2


@pytest.mark.parametrize("failure", [_http_error(429), _http_error(401), RuntimeError("network")])
def test_one_account_failing_does_not_stop_the_other(repo, mirror, failure):
    repo._table.seed(_row("westpac_gone"), _row("up_gone", account_id=UP))
    fetch = _bank_by_account(failure, _bank("u", aid=UP_AID))

    summary = mirror.mirror_pendings("key", repo=repo, category_repo=_Categories(), today=TODAY, fetch=fetch)

    assert _ids(repo) == {"westpac_gone"}
    assert summary["accounts"][WESTPAC]["skipped"]
    assert summary["accounts"][UP]["removed"] == 1


def test_the_api_key_reaches_the_fetch(repo, mirror):
    keys = []

    def fetch(bid, aid, api_key, date_from, date_to):
        keys.append(api_key)
        return _bank("x", aid=aid)

    mirror.mirror_pendings("the-key", repo=repo, category_repo=_Categories(), today=TODAY, fetch=fetch)

    assert keys == ["the-key", "the-key"]


# --- fetch_bank_transactions -------------------------------------------------------------------


class _FakeResponse:
    def __init__(self, payload):
        self._body = json.dumps(payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self._body


def _page(rows, has_more=False, cursor="", success=True):
    return {"success": success, "data": rows,
            "meta": {"count": len(rows), "cursor": cursor, "hasMore": has_more}}


@pytest.fixture
def bank_pages(mirror, monkeypatch):
    """Serve the given pages in order from urlopen; records each request."""
    requests = []
    pages = []

    def urlopen(req, timeout=None):
        requests.append((req, timeout))
        return _FakeResponse(pages.pop(0))

    monkeypatch.setattr(mirror.urllib.request, "urlopen", urlopen)
    return pages, requests


def _fetch(mirror):
    return mirror.fetch_bank_transactions("fiskil_77", WESTPAC_AID, "the-key", "2026-09-19", "2026-09-30")


def test_fetch_follows_the_cursor_to_the_last_page(mirror, bank_pages):
    pages, requests = bank_pages
    pages.extend([_page(_bank("a"), has_more=True, cursor="c1"), _page(_bank("b"))])

    rows = _fetch(mirror)

    assert [row["id"] for row in rows] == ["a", "b"]
    first, second = (urllib.parse.urlsplit(req.full_url) for req, _ in requests)
    assert first.path == f"/v1/banks/fiskil_77/accounts/{WESTPAC_AID}/transactions"
    assert urllib.parse.parse_qs(first.query) == {"from": ["2026-09-19"], "to": ["2026-09-30"]}
    assert urllib.parse.parse_qs(second.query) == {
        "from": ["2026-09-19"], "to": ["2026-09-30"], "cursor": ["c1"],
    }


def test_fetch_sends_the_key_and_our_user_agent_with_a_short_timeout(mirror, bank_pages):
    pages, requests = bank_pages
    pages.append(_page(_bank("a")))

    _fetch(mirror)

    [(req, timeout)] = requests
    assert req.get_header("X-api-key") == "the-key"
    assert req.get_header("User-agent") == "abundo-transaction-trigger"
    assert req.get_method() == "GET"
    assert timeout == 10


@pytest.mark.parametrize("page", [
    _page(_bank("a"), success=False),
    {"success": True, "data": None, "meta": {}},
    _page([{"pending": True}]),
    _page([{"id": "a"}]),
    _page(_bank("a", aid="someone-else")),
    _page(_bank("a"), has_more=True, cursor=""),
])
def test_fetch_rejects_a_reply_that_may_be_partial(mirror, bank_pages, page):
    pages, _ = bank_pages
    pages.append(page)

    with pytest.raises(mirror.MirrorSkip):
        _fetch(mirror)


def test_fetch_gives_up_past_the_page_cap(mirror, bank_pages):
    pages, requests = bank_pages
    pages.extend(_page(_bank(f"r{n}"), has_more=True, cursor=f"c{n}") for n in range(4))

    with pytest.raises(mirror.MirrorSkip):
        _fetch(mirror)
    assert len(requests) == 3


def test_fetch_lets_an_http_error_through(mirror, monkeypatch):
    def urlopen(req, timeout=None):
        raise _http_error(429)

    monkeypatch.setattr(mirror.urllib.request, "urlopen", urlopen)

    with pytest.raises(urllib.error.HTTPError):
        _fetch(mirror)


# --- delete_if_still_pending -------------------------------------------------------------------


def test_delete_if_still_pending_deletes_a_pending(repo):
    repo._table.seed(_row("a"))

    assert repo.delete_if_still_pending("ACCOUNT#westpac-altitude-qantas-black", "TXN#a") is True
    assert _ids(repo) == set()


def test_delete_if_still_pending_leaves_a_posted_row(repo):
    repo._table.seed(_row("a", status="posted"))

    assert repo.delete_if_still_pending("ACCOUNT#westpac-altitude-qantas-black", "TXN#a") is False
    assert _ids(repo) == {"a"}


def test_delete_if_still_pending_on_a_missing_row_is_false(repo):
    assert repo.delete_if_still_pending("ACCOUNT#westpac-altitude-qantas-black", "TXN#a") is False


def test_delete_if_still_pending_leaves_no_deleted_by_you_marker(repo):
    repo._table.seed(_row("a"))

    repo.delete_if_still_pending("ACCOUNT#westpac-altitude-qantas-black", "TXN#a")

    assert repo._table.store == {}


def test_delete_if_still_pending_raises_other_errors(layer, repo):
    repo._table.seed(_row("a"))
    repo._table.fail("delete_item", _client_error("ProvisionedThroughputExceededException"))
    errors = importlib.import_module("repository_errors")

    with pytest.raises(errors.DatabaseError):
        repo.delete_if_still_pending("ACCOUNT#westpac-altitude-qantas-black", "TXN#a")
