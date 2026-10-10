"""WHIT-662: the hourly pending mirror — removal rules, edit carry, skip reasons, the bank-list
fetch and the 29 Sep replay.

Runs the REAL shared TransactionRepository over the in-memory FakeTable. The bank list is faked at
the fetch seam, or at urlopen for the fetch.
"""

import copy
import importlib
import urllib.parse
from decimal import Decimal

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


def _page(rows, has_more=False, cursor="", success=True):
    return {"success": success, "data": rows,
            "meta": {"count": len(rows), "cursor": cursor, "hasMore": has_more}}


# --- mirror_account: what gets removed ---------------------------------------------------------


def test_a_pending_before_the_check_window_is_not_deleted(repo, mirror):
    # Check window starts at today - FEED_WINDOW_DAYS (7) = 22 Sep.
    repo._table.seed(pending_row("kept"), pending_row("old", day="2026-09-21"), pending_row("edge", day="2026-09-22"))

    run_mirror(mirror, repo, bank_rows("kept"), unfiled_except())

    assert stored_ids(repo) == {"kept", "old"}


@pytest.mark.parametrize("day, judged", [("2026-09-30", True), ("2026-10-01", False)])
def test_a_pending_on_the_last_fetched_day_is_judged_and_one_after_it_is_not(repo, mirror, day, judged):
    # The bank list is fetched up to today + 1 (30 Sep), so a missing pending dated then is in
    # scope. One dated 1 Oct can never be in the list: judging it would delete it every run.
    repo._table.seed(pending_row("kept"), pending_row("edge", day=day))

    result = run_mirror(mirror, repo, bank_rows("kept"), unfiled_except())

    assert ("edge" in stored_ids(repo)) is not judged
    assert result["removed"] == int(judged)


def test_a_user_edited_pending_with_no_settled_twin_is_kept_and_counted(repo, mirror):
    repo._table.seed(pending_row("kept"), pending_row("edited", notes="dinner with Sam"))

    result = run_mirror(mirror, repo, bank_rows("kept"), unfiled_except())

    assert stored_ids(repo) == {"kept", "edited"}
    assert result["kept"] == 1
    assert result["carried"] == 0
    assert result["removed"] == 0


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


def test_a_numeric_bank_id_matches_the_stored_string_id(repo, mirror):
    # The webhook stores str(row["id"]); a numeric id in the list must still protect it.
    repo._table.seed(pending_row("12345"), pending_row("gone"))
    bank = [{"id": 12345, "accountId": WESTPAC_AID, "pending": True}]

    run_mirror(mirror, repo, bank, unfiled_except())

    assert stored_ids(repo) == {"12345"}


def test_a_deleted_by_you_marker_survives_the_mirror(repo, mirror):
    # WHIT-654: the user deleted a pending (tombstone written). The bank no longer lists it. The
    # mirror must neither remove the marker nor fail on it.
    repo._table.seed(pending_row("kept"), pending_row("user_deleted"), pending_row("gone"))
    assert repo.delete_transaction(f"ACCOUNT#{WESTPAC}", "TXN#user_deleted") is True

    result = run_mirror(mirror, repo, bank_rows("kept"), unfiled_except())

    assert repo.is_deleted(WESTPAC, "user_deleted") is True
    # A bank-side removal writes no "deleted by you" marker of its own.
    assert repo.is_deleted(WESTPAC, "gone") is False
    assert stored_ids(repo) == {"kept"}
    assert result["removed"] == 1
    assert result["failed"] == 0


# --- mirror_account: carrying a user's edit onto the settled twin (WHIT-663) --------------------


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


@pytest.mark.parametrize("edit", [
    {"notes": "dinner with Sam"},
    {"tags": ["trip"]},
    {"budget_excluded": True},
    {"category": "groceries"},
])
def test_each_kind_of_user_edit_is_carried_and_the_pending_removed(repo, mirror, edit):
    # Card: "own category, note, tags, budget exclusion" — each alone moves to the twin.
    repo._table.seed(pending_row("kept"), pending_row("edited", **edit, **GUZMAN), pending_row("settled", status="posted", **GUZMAN))

    result = run_mirror(mirror, repo, bank_rows("kept"), unfiled_except("groceries"))

    assert stored_ids(repo) == {"kept", "settled"}
    for field_name, value in edit.items():
        assert stored(repo, "settled")[field_name] == value
    assert result["carried"] == 1
    assert result["kept"] == 0
    assert result["failed"] == 0


def test_a_twin_exactly_three_days_before_the_check_window_is_found(repo, mirror):
    # Read boundary: pending on the first checked day (22 Sep), twin on 19 Sep.
    repo._table.seed(
        pending_row("kept"),
        pending_row("edited", day="2026-09-22", notes="dinner with Sam", **GUZMAN),
        pending_row("settled", status="posted", day="2026-09-19", **GUZMAN),
    )

    result = run_mirror(mirror, repo, bank_rows("kept"), unfiled_except())

    assert stored_ids(repo) == {"kept", "settled"}
    assert stored(repo, "settled")["notes"] == "dinner with Sam"
    assert result["carried"] == 1


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


def test_a_notes_only_retry_after_a_failed_delete_finishes_the_job(repo, mirror):
    # A notes-only carry leaves the twin unfiled, so it's still a candidate next hour:
    # the retry carries the same note again (no harm) and removes the pending.
    repo._table.seed(pending_row("kept"), pending_row("edited", notes="dinner with Sam", **GUZMAN), pending_row("settled", status="posted", **GUZMAN))
    repo._table.fail("delete_item")

    first = run_mirror(mirror, repo, bank_rows("kept"), unfiled_except())
    assert first["failed"] == 1
    assert "edited" in stored_ids(repo)

    repo._table.clear_failures()
    second = run_mirror(mirror, repo, bank_rows("kept"), unfiled_except())

    assert stored_ids(repo) == {"kept", "settled"}
    assert stored(repo, "settled")["notes"] == "dinner with Sam"
    assert second["carried"] == 1
    assert second["failed"] == 0


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


def test_one_failed_carry_does_not_stop_the_next_pending_carrying(repo, mirror):
    # Per-pending isolation: A's carry write fails (kept), B still carries.
    other = {"amount": Decimal("-7.00"), "merchant_name": "Coles", "description": "COLES 1234"}
    repo._table.seed(
        pending_row("kept"),
        pending_row("a", notes="lunch", **GUZMAN), pending_row("a_settled", status="posted", **GUZMAN),
        pending_row("b", notes="milk", **other), pending_row("b_settled", status="posted", **other),
    )
    repo._table.fail("batch_writer", when=lambda item: item["sk"] == "TXN#a_settled")

    result = run_mirror(mirror, repo, bank_rows("kept"), unfiled_except())

    assert stored_ids(repo) == {"kept", "a", "a_settled", "b_settled"}
    assert stored(repo, "b_settled")["notes"] == "milk"
    assert "notes" not in stored(repo, "a_settled")
    assert result["failed"] == 1
    assert result["carried"] == 1


def test_the_carry_is_saved_before_the_pending_is_deleted(repo, mirror):
    # Never lose an edit: the batch put of the twin happens first, the delete after.
    repo._table.seed(pending_row("kept"), pending_row("edited", notes="dinner with Sam", **GUZMAN), pending_row("settled", status="posted", **GUZMAN))
    order = []
    real_insert, real_delete = repo.insert_transactions, repo.delete_if_still_pending

    def insert(rows):
        order.append("carry")
        return real_insert(rows)

    def delete(pk, sk):
        order.append("delete")
        return real_delete(pk, sk)

    repo.insert_transactions, repo.delete_if_still_pending = insert, delete

    run_mirror(mirror, repo, bank_rows("kept"), unfiled_except())

    assert order == ["carry", "delete"]


# --- mirror_account: skips ---------------------------------------------------------------------


def test_an_empty_bank_list_deletes_nothing(repo, mirror):
    repo._table.seed(pending_row("a"))

    result = run_mirror(mirror, repo, [], unfiled_except())

    assert stored_ids(repo) == {"a"}
    assert result["skipped"] == "empty"


@pytest.mark.parametrize("missing, deleted, result_field, result_value", [
    (10, True, "removed", 10),
    (11, False, "skipped", "too_many_removals"),
])
def test_exactly_the_cap_is_removed_and_one_more_deletes_nothing(repo, mirror, missing, deleted, result_field, result_value):
    missing_ids = {f"missing{n}" for n in range(missing)}
    repo._table.seed(pending_row("kept"), *(pending_row(transaction_id) for transaction_id in missing_ids))

    result = run_mirror(mirror, repo, bank_rows("kept"), unfiled_except())

    expected = {"kept"} if deleted else {"kept"} | missing_ids
    assert stored_ids(repo) == expected
    assert result[result_field] == result_value


def test_the_removal_cap_counts_only_in_window_pendings(repo, mirror):
    # 11 missing posted rows and 11 missing out-of-window pendings are not candidates, so
    # they must not trip the cap and block the one real removal.
    repo._table.seed(
        pending_row("kept"),
        pending_row("gone"),
        *(pending_row(f"posted{n}", status="posted") for n in range(11)),
        *(pending_row(f"old{n}", day="2026-09-10") for n in range(11)),
    )

    result = run_mirror(mirror, repo, bank_rows("kept"), unfiled_except())

    assert "gone" not in stored_ids(repo)
    assert result["removed"] == 1
    assert result["skipped"] is None


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


@pytest.fixture
def bank_by_aid(mirror, monkeypatch):
    """urlopen serving a list of pages per account aid; records each request."""
    pages = {WESTPAC_AID: [], UP_AID: []}
    requests = []

    def urlopen(req, timeout=None):
        requests.append(req)
        aid = urllib.parse.urlsplit(req.full_url).path.split("/")[5]
        reply = pages[aid].pop(0)
        if isinstance(reply, Exception):
            raise reply
        return FakeResponse(reply)

    monkeypatch.setattr(mirror.urllib.request, "urlopen", urlopen)
    return pages, requests


def test_the_real_fetch_mirrors_both_accounts_with_their_own_lists(repo, mirror, bank_by_aid):
    # Each account is judged only against its own bank list: Westpac listing Up's id must
    # not save Up's dropped pending. The URLs carry the fixed-today window and the key.
    pages, requests = bank_by_aid
    repo._table.seed(pending_row("w_kept"), pending_row("w_gone"), pending_row("u_kept", account_id=UP), pending_row("u_gone", account_id=UP))
    pages[WESTPAC_AID].append(_page(bank_rows("w_kept", "u_gone")))
    pages[UP_AID].append(_page(bank_rows("u_kept", aid=UP_AID)))

    summary = mirror.mirror_pendings("the-key", repo=repo, category_repo=_FakeCategoryRepo(), today=MIRROR_TODAY)

    assert stored_ids(repo) == {"w_kept", "u_kept"}
    assert summary["removed"] == 2
    assert summary["skipped"] == 0
    assert [urllib.parse.urlsplit(req.full_url).path for req in requests] == [
        f"/v1/banks/fiskil_77/accounts/{WESTPAC_AID}/transactions",
        f"/v1/banks/fiskil_3/accounts/{UP_AID}/transactions",
    ]
    for req in requests:
        assert urllib.parse.parse_qs(urllib.parse.urlsplit(req.full_url).query) == {
            "from": ["2026-09-19"], "to": ["2026-09-30"],
        }
        assert req.get_header("X-api-key") == "the-key"


@pytest.mark.parametrize("second_page", [_page(bank_rows("b"), success=False), http_error(429)])
def test_a_bad_second_page_deletes_nothing_for_that_account(repo, mirror, bank_by_aid, second_page):
    # Page 1 is fine and says there's more; page 2 fails. The partial page-1 list must
    # never be used to delete (it lacks "b"). Up still runs.
    pages, _ = bank_by_aid
    repo._table.seed(pending_row("a"), pending_row("b"), pending_row("u_gone", account_id=UP))
    pages[WESTPAC_AID].extend([_page(bank_rows("a"), has_more=True, cursor="c1"), second_page])
    pages[UP_AID].append(_page(bank_rows("u", aid=UP_AID)))

    summary = mirror.mirror_pendings("key", repo=repo, category_repo=_FakeCategoryRepo(), today=MIRROR_TODAY)

    assert stored_ids(repo) == {"a", "b"}
    assert summary["accounts"][WESTPAC]["skipped"]
    assert summary["accounts"][UP]["removed"] == 1
    assert summary["skipped"] == 1


# --- fetch_bank_transactions -------------------------------------------------------------------


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


@pytest.mark.parametrize("third_page_has_more", [False, True])
def test_fetch_accepts_exactly_the_page_cap_and_gives_up_past_it(mirror, bank_pages, third_page_has_more):
    # 3 pages, the last with hasMore false, is a complete list. A 3rd page still saying "more"
    # is past the cap, so the list may be partial.
    pages, requests = bank_pages
    pages.extend([
        _page(bank_rows("a"), has_more=True, cursor="c1"),
        _page(bank_rows("b"), has_more=True, cursor="c2"),
        _page(bank_rows("c"), has_more=third_page_has_more, cursor="c3"),
        _page(bank_rows("d")),
    ])

    if third_page_has_more:
        with pytest.raises(mirror.MirrorSkip):
            _fetch(mirror)
    else:
        assert [row["id"] for row in _fetch(mirror)] == ["a", "b", "c"]
    assert len(requests) == 3


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


# --- delete_if_still_pending -------------------------------------------------------------------


@pytest.mark.parametrize("seeded, deleted, left", [
    ([pending_row("a")], True, set()),
    ([pending_row("a", status="posted")], False, {(f"ACCOUNT#{WESTPAC}", "TXN#a")}),
    ([], False, set()),
])
def test_delete_if_still_pending_deletes_only_a_stored_pending(repo, seeded, deleted, left):
    # A removed pending leaves nothing behind: no "deleted by you" marker.
    repo._table.seed(*seeded)

    assert repo.delete_if_still_pending(f"ACCOUNT#{WESTPAC}", "TXN#a") is deleted
    assert set(repo._table.store) == left


def test_delete_if_still_pending_raises_other_errors(layer, repo):
    repo._table.seed(pending_row("a"))
    repo._table.fail("delete_item", _client_error("ProvisionedThroughputExceededException"))
    errors = importlib.import_module("repository_errors")

    with pytest.raises(errors.DatabaseError):
        repo.delete_if_still_pending(f"ACCOUNT#{WESTPAC}", "TXN#a")


# --- 29 Sep 2026 replay ------------------------------------------------------------------------
# BankSync's full Westpac Altitude list lacked three pendings we still stored (the re-worded
# Costco / Talad Thai "Pending -" copies and the myki $1 tap-on hold). The mirror must delete
# exactly those three and leave every other row alone.


def _replay_row(transaction_id, day, amount, description, status, account_id=WESTPAC):
    return pending_row(transaction_id, day, status, account_id, amount=Decimal(amount), description=description)


DROPPED_IDS = {
    "bank_tx_e937046f0001",  # 28 Sep Costco -195.26 "Pending - ..." copy
    "bank_tx_4fa44d040001",  # 27 Sep Talad Thai -65.45 "Pending - ..." copy
    "bank_tx_33e1f5790001",  # 24 Sep myki tap-on hold -1.00
}

# Rows the bank still lists.
KEPT_ROWS = [
    _replay_row("bank_tx_costco_posted", "2026-09-28", "-195.26", "COSTCO WHOLESALE DOCKLANDS", "posted"),
    _replay_row("bank_tx_talad_posted", "2026-09-27", "-65.45", "TALAD THAI MELBOURNE", "posted"),
    _replay_row("bank_tx_myki_fare", "2026-09-25", "-5.70", "MYKI TRANSPORT FARE", "posted"),
    _replay_row("bank_tx_coles_pending", "2026-09-28", "-42.10", "PENDING - COLES 0412", "pending"),
    _replay_row("bank_tx_woolies_posted", "2026-09-23", "-88.00", "WOOLWORTHS 3321", "posted"),
    _replay_row("bank_tx_uber_pending", "2026-09-29", "-18.40", "PENDING - UBER *TRIP", "pending"),
]

DROPPED_ROWS = [
    _replay_row("bank_tx_e937046f0001", "2026-09-28", "-195.26", "Pending - COSTCO WHOLESALE DOCKLANDS", "pending"),
    _replay_row("bank_tx_4fa44d040001", "2026-09-27", "-65.45", "Pending - TALAD THAI MELBOURNE", "pending"),
    _replay_row("bank_tx_33e1f5790001", "2026-09-24", "-1.00", "MYKI TAP ON", "pending"),
]

# Rows the mirror must never touch on this account's run.
UNTOUCHABLE_ROWS = [
    # A posted row the bank no longer lists: posted rows are never deleted.
    _replay_row("bank_tx_posted_gone", "2026-09-26", "-12.00", "OLD POSTED", "posted"),
    # A pending before the check window (today - FEED_WINDOW_DAYS): left to age-out.
    _replay_row("bank_tx_old_pending", "2026-09-10", "-9.99", "PENDING - OLD", "pending"),
    # Another account's pending: not this account's business.
    _replay_row("up_tx_pending", "2026-09-28", "-7.50", "UP PENDING", "pending", account_id=UP),
]


def _bank_row(row):
    return {
        "id": row["transaction_id"],
        "accountId": WESTPAC_AID,
        "pending": row["status"] == "pending",
        "date": row["date"],
        "authorizedDate": row["date"],
        "amount": float(row["amount"]),
        "description": row["description"],
    }


def test_29_sep_replay_removes_exactly_the_three_dropped_pendings(repo, mirror):
    repo._table.seed(*(KEPT_ROWS + DROPPED_ROWS + UNTOUCHABLE_ROWS))
    before = copy.deepcopy(repo._table.store)

    result = run_mirror(mirror, repo, [_bank_row(row) for row in KEPT_ROWS], unfiled_except())

    removed = {key[1].removeprefix("TXN#") for key in set(before) - set(repo._table.store)}
    assert removed == DROPPED_IDS
    for key, item in repo._table.store.items():
        assert item == before[key]
    assert result["removed"] == 3
    assert result["skipped"] is None
