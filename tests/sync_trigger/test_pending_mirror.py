"""WHIT-662: the hourly pending mirror — removal rules, skip reasons and the bank-list fetch.

Runs the REAL shared TransactionRepository over the in-memory FakeTable (see the replay test for
the fixture's reasoning). The bank list is faked at the fetch seam, or at urlopen for the fetch.
"""

import copy
import importlib
import urllib.error
import urllib.parse

import pytest

from _budget_endpoint_fakes import _FakeCategoryRepo
from _dynamo_fakes import _client_error
from _http_fakes import FakeResponse, http_error
from _pending_mirror_fakes import (
    GUZMAN,
    MIRROR_TODAY,
    UP,
    UP_AID,
    WESTPAC,
    WESTPAC_AID,
    WESTPAC_SOURCE,
    bank_rows,
    pending_row,
    run_mirror,
    stored,
    stored_ids,
    unfiled_except,
)


# --- mirror_account: what gets removed ---------------------------------------------------------


def test_a_posted_row_missing_from_the_bank_list_is_not_deleted(repo, mirror):
    repo._table.seed(pending_row("kept"), pending_row("posted_gone", status="posted"))

    result = run_mirror(mirror, repo, bank_rows("kept"), unfiled_except())

    assert stored_ids(repo) == {"kept", "posted_gone"}
    assert result["removed"] == 0


def test_a_pending_before_the_check_window_is_not_deleted(repo, mirror):
    # Check window starts at today - FEED_WINDOW_DAYS (7) = 22 Sep.
    repo._table.seed(pending_row("kept"), pending_row("old", day="2026-09-21"), pending_row("edge", day="2026-09-22"))

    run_mirror(mirror, repo, bank_rows("kept"), unfiled_except())

    assert stored_ids(repo) == {"kept", "old"}


def test_a_user_edited_pending_with_no_settled_twin_is_kept_and_counted(repo, mirror):
    repo._table.seed(pending_row("kept"), pending_row("edited", notes="dinner with Sam"))

    result = run_mirror(mirror, repo, bank_rows("kept"), unfiled_except())

    assert stored_ids(repo) == {"kept", "edited"}
    assert result["kept"] == 1
    assert result["carried"] == 0
    assert result["removed"] == 0


def test_a_user_edited_pending_moves_its_edit_onto_the_settled_twin(repo, mirror):
    repo._table.seed(
        pending_row("kept"),
        pending_row("edited", category="groceries", notes="dinner with Sam", **GUZMAN),
        pending_row("settled", status="posted", day="2026-09-29", **GUZMAN),
    )

    result = run_mirror(mirror, repo, bank_rows("kept"), unfiled_except("groceries"))

    assert stored_ids(repo) == {"kept", "settled"}
    assert stored(repo, "settled")["category"] == "groceries"
    assert stored(repo, "settled")["notes"] == "dinner with Sam"
    assert result["carried"] == 1
    assert result["kept"] == 0


def test_a_failed_carry_keeps_the_pending_and_leaves_the_twin_alone(repo, mirror):
    repo._table.seed(
        pending_row("kept"),
        pending_row("edited", notes="dinner with Sam", **GUZMAN),
        pending_row("settled", status="posted", **GUZMAN),
    )
    repo._table.fail("batch_writer")

    result = run_mirror(mirror, repo, bank_rows("kept"), unfiled_except())

    assert stored_ids(repo) == {"kept", "edited", "settled"}
    assert "notes" not in stored(repo, "settled")
    assert result["failed"] == 1
    assert result["carried"] == 0


def test_a_failed_delete_after_the_carry_is_retried_without_carrying_twice(repo, mirror):
    repo._table.seed(
        pending_row("kept"),
        pending_row("edited", category="groceries", notes="dinner with Sam", **GUZMAN),
        pending_row("settled", status="posted", **GUZMAN),
    )
    repo._table.fail("delete_item")

    first = run_mirror(mirror, repo, bank_rows("kept"), unfiled_except("groceries"))

    assert first["failed"] == 1
    assert stored(repo, "settled")["notes"] == "dinner with Sam"
    carried_twin = dict(stored(repo, "settled"))

    repo._table.clear_failures()
    second = run_mirror(mirror, repo, bank_rows("kept"), unfiled_except("groceries"))

    assert stored(repo, "settled") == carried_twin
    assert second["failed"] == 0
    assert second["carried"] == 0
    assert second["kept"] == 1


def test_a_settled_twin_dated_before_the_check_window_is_still_found(repo, mirror):
    # Check window starts 22 Sep; the twin settled-dated 20 Sep is inside the 3-day carry skew.
    repo._table.seed(
        pending_row("kept"),
        pending_row("edited", day="2026-09-22", notes="dinner with Sam", **GUZMAN),
        pending_row("settled", status="posted", day="2026-09-20", **GUZMAN),
    )

    result = run_mirror(mirror, repo, bank_rows("kept"), unfiled_except())

    assert stored_ids(repo) == {"kept", "settled"}
    assert stored(repo, "settled")["notes"] == "dinner with Sam"
    assert result["carried"] == 1


def test_a_pending_in_the_extra_read_days_is_not_judged(repo, mirror):
    repo._table.seed(pending_row("kept"), pending_row("early", day="2026-09-20"))

    result = run_mirror(mirror, repo, bank_rows("kept"), unfiled_except())

    assert stored_ids(repo) == {"kept", "early"}
    assert result["checked"] == 1


def test_a_settled_charge_the_user_filed_is_never_overwritten(repo, mirror):
    repo._table.seed(
        pending_row("kept"),
        pending_row("edited", category="groceries", notes="dinner with Sam", **GUZMAN),
        pending_row("settled", status="posted", category="dining", **GUZMAN),
    )

    result = run_mirror(mirror, repo, bank_rows("kept"), unfiled_except("groceries", "dining"))

    assert stored_ids(repo) == {"kept", "edited", "settled"}
    assert stored(repo, "settled")["category"] == "dining"
    assert "notes" not in stored(repo, "settled")
    assert result["kept"] == 1


def test_two_edited_pendings_with_one_settled_twin_carry_only_once(repo, mirror):
    repo._table.seed(
        pending_row("kept"),
        pending_row("first", notes="dinner with Sam", **GUZMAN),
        pending_row("second", notes="lunch with Kim", **GUZMAN),
        pending_row("settled", status="posted", **GUZMAN),
    )

    result = run_mirror(mirror, repo, bank_rows("kept"), unfiled_except())

    assert len(stored_ids(repo)) == 3
    assert result["carried"] == 1
    assert result["kept"] == 1


def test_a_pending_already_settled_or_gone_is_counted_as_gone(repo, mirror):
    repo._table.seed(pending_row("kept"), pending_row("settling"))
    # The webhook posts the row between our read and our delete.
    repo._table.before_next_write(lambda key, table: table.store[(key["pk"], key["sk"])].update(status="posted"))

    result = run_mirror(mirror, repo, bank_rows("kept"), unfiled_except())

    assert stored_ids(repo) == {"kept", "settling"}
    assert result["gone"] == 1
    assert result["removed"] == 0


def test_a_failed_delete_does_not_stop_the_others(repo, mirror):
    repo._table.seed(pending_row("kept"), pending_row("a"), pending_row("b"))
    repo._table.fail("delete_item", when=lambda key: key["sk"] == "TXN#a")

    result = run_mirror(mirror, repo, bank_rows("kept"), unfiled_except())

    assert stored_ids(repo) == {"kept", "a"}
    assert result["failed"] == 1
    assert result["removed"] == 1


def test_a_pending_the_bank_lists_as_posted_is_kept(repo, mirror):
    repo._table.seed(pending_row("kept"), pending_row("now_posted"))
    bank = bank_rows("kept") + [{"id": "now_posted", "accountId": WESTPAC_AID, "pending": False}]

    run_mirror(mirror, repo, bank, unfiled_except())

    assert stored_ids(repo) == {"kept", "now_posted"}


# --- mirror_account: skips ---------------------------------------------------------------------


def test_an_empty_bank_list_deletes_nothing(repo, mirror):
    repo._table.seed(pending_row("a"))

    result = run_mirror(mirror, repo, [], unfiled_except())

    assert stored_ids(repo) == {"a"}
    assert result["skipped"] == "empty"


def test_more_missing_than_the_cap_deletes_nothing(repo, mirror):
    repo._table.seed(pending_row("kept"), *(pending_row(f"missing{n}") for n in range(11)))

    result = run_mirror(mirror, repo, bank_rows("kept"), unfiled_except())

    assert len(stored_ids(repo)) == 12
    assert result["skipped"] == "too_many_removals"


def test_exactly_the_cap_is_still_removed(repo, mirror):
    repo._table.seed(pending_row("kept"), *(pending_row(f"missing{n}") for n in range(10)))

    result = run_mirror(mirror, repo, bank_rows("kept"), unfiled_except())

    assert stored_ids(repo) == {"kept"}
    assert result["removed"] == 10


def test_a_fetch_error_propagates_and_deletes_nothing(repo, mirror):
    repo._table.seed(pending_row("a"))

    def fetch(*args):
        raise mirror.MirrorSkip("success is not true")

    with pytest.raises(mirror.MirrorSkip):
        mirror.mirror_account(repo, fetch, WESTPAC_SOURCE, MIRROR_TODAY, unfiled_except())
    assert stored_ids(repo) == {"a"}


def test_our_rows_are_read_before_the_bank_list_is_fetched(repo, mirror):
    repo._table.seed(pending_row("kept"))
    calls = []
    original_query = repo._table.query

    def query(**kwargs):
        calls.append("read")
        return original_query(**kwargs)

    repo._table.query = query

    def fetch(*args):
        calls.append("fetch")
        return bank_rows("kept")

    mirror.mirror_account(repo, fetch, WESTPAC_SOURCE, MIRROR_TODAY, unfiled_except())

    assert calls == ["read", "fetch"]


def test_the_fetch_window_reaches_back_past_the_feed_window_to_tomorrow(repo, mirror):
    calls = []

    def fetch(*args):
        calls.append(args)
        return bank_rows("x")

    mirror.mirror_account(repo, fetch, WESTPAC_SOURCE, MIRROR_TODAY, unfiled_except())

    assert calls == [("fiskil_77", WESTPAC_AID, "2026-09-19", "2026-09-30")]


# --- mirror_pendings ----------------------------------------------------------------------------


def _bank_by_account(westpac, up):
    def fetch(api_key, bid, aid, date_from, date_to):
        if aid == WESTPAC_AID:
            if isinstance(westpac, Exception):
                raise westpac
            return copy.deepcopy(westpac)
        return copy.deepcopy(up)
    return fetch


def test_user_filed_and_rule_filed_pendings(repo, mirror):
    repo._table.seed(
        pending_row("kept"),
        pending_row("user_category", category="groceries"),
        pending_row("rule_category", category="groceries", filed_by_rule="rule-1"),
        pending_row("noted", notes="x"),
        pending_row("tagged", tags=["trip"]),
        pending_row("excluded", budget_excluded=True),
        pending_row("raw_bank_category", category="FOOD_AND_DRINK"),
    )
    fetch = _bank_by_account(bank_rows("kept"), bank_rows("u", aid=UP_AID))

    summary = mirror.mirror_pendings(
        "key", repo=repo, category_repo=_FakeCategoryRepo([{"id": "groceries"}]), today=MIRROR_TODAY, fetch=fetch
    )

    assert stored_ids(repo) == {"kept", "user_category", "noted", "tagged", "excluded"}
    assert summary["removed"] == 2
    assert summary["kept"] == 4


def test_a_category_read_failure_skips_every_account(repo, mirror):
    repo._table.seed(pending_row("gone"))
    fetch = _bank_by_account(bank_rows("kept"), bank_rows("u", aid=UP_AID))

    summary = mirror.mirror_pendings(
        "key", repo=repo, category_repo=_FakeCategoryRepo(error=RuntimeError("down")), today=MIRROR_TODAY, fetch=fetch
    )

    assert stored_ids(repo) == {"gone"}
    assert summary["skipped"] == 2


@pytest.mark.parametrize("failure", [http_error(429), http_error(401), RuntimeError("network")])
def test_one_account_failing_does_not_stop_the_other(repo, mirror, failure):
    repo._table.seed(pending_row("westpac_gone"), pending_row("up_gone", account_id=UP))
    fetch = _bank_by_account(failure, bank_rows("u", aid=UP_AID))

    summary = mirror.mirror_pendings("key", repo=repo, category_repo=_FakeCategoryRepo(), today=MIRROR_TODAY, fetch=fetch)

    assert stored_ids(repo) == {"westpac_gone"}
    assert summary["accounts"][WESTPAC]["skipped"]
    assert summary["accounts"][UP]["removed"] == 1


def test_the_api_key_reaches_the_fetch(repo, mirror):
    keys = []

    def fetch(api_key, bid, aid, date_from, date_to):
        keys.append(api_key)
        return bank_rows("x", aid=aid)

    mirror.mirror_pendings("the-key", repo=repo, category_repo=_FakeCategoryRepo(), today=MIRROR_TODAY, fetch=fetch)

    assert keys == ["the-key", "the-key"]


# --- fetch_bank_transactions -------------------------------------------------------------------


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
        return FakeResponse(pages.pop(0))

    monkeypatch.setattr(mirror.urllib.request, "urlopen", urlopen)
    return pages, requests


def _fetch(mirror):
    return mirror.fetch_bank_transactions("the-key", "fiskil_77", WESTPAC_AID, "2026-09-19", "2026-09-30")


def test_fetch_follows_the_cursor_to_the_last_page(mirror, bank_pages):
    pages, requests = bank_pages
    pages.extend([_page(bank_rows("a"), has_more=True, cursor="c1"), _page(bank_rows("b"))])

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
    pages.append(_page(bank_rows("a")))

    _fetch(mirror)

    [(req, timeout)] = requests
    assert req.get_header("X-api-key") == "the-key"
    assert req.get_header("User-agent") == "abundo-transaction-trigger"
    assert req.get_method() == "GET"
    assert timeout == 10


@pytest.mark.parametrize("page", [
    _page(bank_rows("a"), success=False),
    {"success": True, "data": None, "meta": {}},
    _page([{"pending": True}]),
    _page([{"id": "a"}]),
    _page(bank_rows("a", aid="someone-else")),
    _page(bank_rows("a"), has_more=True, cursor=""),
])
def test_fetch_rejects_a_reply_that_may_be_partial(mirror, bank_pages, page):
    pages, _ = bank_pages
    pages.append(page)

    with pytest.raises(mirror.MirrorSkip):
        _fetch(mirror)


def test_fetch_gives_up_past_the_page_cap(mirror, bank_pages):
    pages, requests = bank_pages
    pages.extend(_page(bank_rows(f"r{n}"), has_more=True, cursor=f"c{n}") for n in range(4))

    with pytest.raises(mirror.MirrorSkip):
        _fetch(mirror)
    assert len(requests) == 3


def test_fetch_lets_an_http_error_through(mirror, monkeypatch):
    def urlopen(req, timeout=None):
        raise http_error(429)

    monkeypatch.setattr(mirror.urllib.request, "urlopen", urlopen)

    with pytest.raises(urllib.error.HTTPError):
        _fetch(mirror)


# --- delete_if_still_pending -------------------------------------------------------------------


def test_delete_if_still_pending_deletes_a_pending(repo):
    repo._table.seed(pending_row("a"))

    assert repo.delete_if_still_pending("ACCOUNT#westpac-altitude-qantas-black", "TXN#a") is True
    assert stored_ids(repo) == set()


def test_delete_if_still_pending_leaves_a_posted_row(repo):
    repo._table.seed(pending_row("a", status="posted"))

    assert repo.delete_if_still_pending("ACCOUNT#westpac-altitude-qantas-black", "TXN#a") is False
    assert stored_ids(repo) == {"a"}


def test_delete_if_still_pending_on_a_missing_row_is_false(repo):
    assert repo.delete_if_still_pending("ACCOUNT#westpac-altitude-qantas-black", "TXN#a") is False


def test_delete_if_still_pending_leaves_no_deleted_by_you_marker(repo):
    repo._table.seed(pending_row("a"))

    repo.delete_if_still_pending("ACCOUNT#westpac-altitude-qantas-black", "TXN#a")

    assert repo._table.store == {}


def test_delete_if_still_pending_raises_other_errors(layer, repo):
    repo._table.seed(pending_row("a"))
    repo._table.fail("delete_item", _client_error("ProvisionedThroughputExceededException"))
    errors = importlib.import_module("repository_errors")

    with pytest.raises(errors.DatabaseError):
        repo.delete_if_still_pending("ACCOUNT#westpac-altitude-qantas-black", "TXN#a")
