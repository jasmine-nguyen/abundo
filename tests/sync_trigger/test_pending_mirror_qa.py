"""WHIT-662 QA: adversarial checks on the pending mirror — window edges, tombstones, the real
fetch end to end, logging, and the handler call site. Runs the REAL shared TransactionRepository
over FakeTable, the same way test_pending_mirror.py does.
"""

import logging
import urllib.parse
from decimal import Decimal

import pytest

from _budget_endpoint_fakes import _FakeCategoryRepo
from _http_fakes import FakeResponse, http_error
from _pending_mirror_fakes import (
    MIRROR_TODAY,
    UP,
    UP_AID,
    WESTPAC,
    WESTPAC_AID,
    bank_rows,
    pending_row,
    run_mirror,
    stored_ids,
    unfiled_except,
)


def _page(rows, has_more=False, cursor="", success=True):
    return {"success": success, "data": rows,
            "meta": {"count": len(rows), "cursor": cursor, "hasMore": has_more}}


# --- window edges ------------------------------------------------------------------------------


def test_a_pending_dated_after_the_fetch_window_is_not_deleted(repo, mirror):
    # [A1] The bank list is fetched up to today + 1 (booking date), so it can never contain a row
    # dated 1 Oct. Judging that row against it would delete it on every run: the card says
    # "Never touch rows outside the window".
    repo._table.seed(pending_row("kept"), pending_row("future", day="2026-10-01"))

    result = run_mirror(mirror, repo, bank_rows("kept"), unfiled_except())

    assert stored_ids(repo) == {"kept", "future"}
    assert result["removed"] == 0


def test_a_pending_dated_on_the_last_fetched_day_is_still_judged(repo, mirror):
    # [A2] The fetch reaches to tomorrow, so a missing pending dated tomorrow is in scope.
    repo._table.seed(pending_row("kept"), pending_row("tomorrow", day="2026-09-30"))

    run_mirror(mirror, repo, bank_rows("kept"), unfiled_except())

    assert stored_ids(repo) == {"kept"}


def test_the_removal_cap_counts_only_in_window_pendings(repo, mirror):
    # [A3] 11 missing posted rows and 11 missing out-of-window pendings are not candidates, so
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


def test_a_numeric_bank_id_matches_the_stored_string_id(repo, mirror):
    # [A4] The webhook stores str(row["id"]); a numeric id in the list must still protect it.
    repo._table.seed(pending_row("12345"), pending_row("gone"))
    bank = [{"id": 12345, "accountId": WESTPAC_AID, "pending": True}]

    run_mirror(mirror, repo, bank, unfiled_except())

    assert stored_ids(repo) == {"12345"}


# --- WHIT-654 tombstones -----------------------------------------------------------------------


def test_a_deleted_by_you_marker_survives_the_mirror(repo, mirror):
    # [A5] The user deleted a pending (tombstone written). The bank no longer lists it. The mirror
    # must neither remove the marker nor fail on it.
    repo._table.seed(pending_row("kept"), pending_row("user_deleted"), pending_row("gone"))
    assert repo.delete_transaction(f"ACCOUNT#{WESTPAC}", "TXN#user_deleted") is True

    result = run_mirror(mirror, repo, bank_rows("kept"), unfiled_except())

    assert repo.is_deleted(WESTPAC, "user_deleted") is True
    # A bank-side removal writes no "deleted by you" marker of its own.
    assert repo.is_deleted(WESTPAC, "gone") is False
    assert stored_ids(repo) == {"kept"}
    assert result["removed"] == 1
    assert result["failed"] == 0


# --- mirror_pendings end to end over the real fetch -------------------------------------------


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
    # [A6] Each account is judged only against its own bank list: Westpac listing Up's id must
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
    # [A7] Page 1 is fine and says there's more; page 2 fails. The partial page-1 list must
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


def test_exactly_the_page_cap_is_accepted(mirror, bank_by_aid):
    # [A8] 3 pages, the last with hasMore false, is a complete list — not over the cap.
    pages, requests = bank_by_aid
    pages[WESTPAC_AID].extend([
        _page(bank_rows("a"), has_more=True, cursor="c1"),
        _page(bank_rows("b"), has_more=True, cursor="c2"),
        _page(bank_rows("c")),
    ])

    rows = mirror.fetch_bank_transactions("fiskil_77", WESTPAC_AID, "k", "2026-09-19", "2026-09-30")

    assert [row["id"] for row in rows] == ["a", "b", "c"]
    assert len(requests) == 3


def test_our_read_failing_skips_that_account_only(repo, mirror, bank_by_aid):
    # [A9] A DynamoDB error reading Westpac's rows skips Westpac; Up is still mirrored.
    pages, _ = bank_by_aid
    repo._table.seed(pending_row("w_gone"), pending_row("u_gone", account_id=UP))
    pages[WESTPAC_AID].append(_page(bank_rows("x")))
    pages[UP_AID].append(_page(bank_rows("u", aid=UP_AID)))
    repo._table.fail(
        "query",
        when=lambda kwargs: ("account_id", "eq", WESTPAC) in kwargs["KeyConditionExpression"].conditions,
    )

    summary = mirror.mirror_pendings("key", repo=repo, category_repo=_FakeCategoryRepo(), today=MIRROR_TODAY)

    assert stored_ids(repo) == {"w_gone"}
    assert summary["accounts"][WESTPAC]["skipped"]
    assert summary["accounts"][UP]["removed"] == 1


# --- logging -----------------------------------------------------------------------------------


def test_each_removal_and_the_run_summary_are_logged(repo, mirror, caplog):
    # [A10] Card: "Log each removal (ids + amounts) and a per-run summary".
    repo._table.seed(pending_row("kept"), pending_row("costco", amount=Decimal("-195.26")))

    def fetch(bid, aid, api_key, date_from, date_to):
        return bank_rows("kept", aid=aid)

    with caplog.at_level(logging.INFO, logger="pending_mirror"):
        mirror.mirror_pendings("key", repo=repo, category_repo=_FakeCategoryRepo(), today=MIRROR_TODAY, fetch=fetch)

    removal = [r.getMessage() for r in caplog.records if "removed account=" in r.getMessage()]
    assert len(removal) == 1
    assert "txn=costco" in removal[0] and "-195.26" in removal[0]
    assert any("pending_mirror summary: removed=1" in r.getMessage() for r in caplog.records)


def test_an_income_tagged_pending_is_kept(repo, mirror):
    # [A11] Plan risk: a pending the bank tagged "income" counts as filed → kept for age-out.
    repo._table.seed(pending_row("kept"), pending_row("refund", category="income"))

    def fetch(bid, aid, api_key, date_from, date_to):
        return bank_rows("kept", aid=aid)

    summary = mirror.mirror_pendings("key", repo=repo, category_repo=_FakeCategoryRepo(), today=MIRROR_TODAY, fetch=fetch)

    assert stored_ids(repo) == {"kept", "refund"}
    assert summary["kept"] == 1


# --- handler call site -------------------------------------------------------------------------


def test_the_mirror_still_runs_when_every_feed_fails(monkeypatch):
    # [A12] A failed sync POST must not stop the mirror (it runs before the final raise), and
    # the run still raises for the WHIT-644 alarm.
    import handler

    monkeypatch.setattr(handler, "get_api_key", lambda: "the-key")
    monkeypatch.setattr(handler, "forget_api_key", lambda path: None)

    def urlopen(req, timeout=None):
        raise http_error(500)

    monkeypatch.setattr(handler.urllib.request, "urlopen", urlopen)
    calls = []
    monkeypatch.setattr(handler.pending_mirror, "mirror_pendings", lambda api_key: calls.append(api_key))

    with pytest.raises(RuntimeError, match="sync trigger failed"):
        handler.lambda_handler({}, None)
    assert calls == ["the-key"]
