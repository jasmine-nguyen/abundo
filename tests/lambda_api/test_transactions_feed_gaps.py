"""WHIT — GET /transactions/feed — ADVERSARIAL GAP suite.

Independent, adversarial half of the feed coverage. The implementer's
test_transactions_feed.py already locks: first-page-all-accounts/no-floor, default
FEED_PAGE_SIZE, row shaping, multi-page no-dupe/no-gap at several sizes, equal-date
straddle, ancient-account keep-prior-cursor, single/empty history, last-page null cursor,
the trailing-LastEvaluatedKey quirk, cursor round-trip, limit clamp (>max / zero),
non-numeric limit -> 400, malformed / cross-account / wrong-shape cursor -> 400,
encode/decode unit round-trips, dispatch through lambda_handler. We DO NOT re-test those.

Gaps hunted here:
  [G1] page size > total history            -> one page, null cursor
  [G2] an account exhausts mid-drain        -> it drops from the cursor, others continue,
                                               nothing lost / duplicated
  [G3] page size CHANGED mid-pagination     -> correctness (no dupe/no gap/newest-first)
                                               survives a limit=A -> limit=B cursor
  [G4] resume landing on a same-date boundary WITHIN one account (with a size change)
  [G5] whitespace / float / negative / whitespace-only limit strings
  [G6] cursor base64-decodes to valid JSON that ISN'T an object (list/str/num/bool/null)
  [G7] a large, validly-shaped resume map naming UNKNOWN account ids -> tolerated (200)
  [G8] Decimal amounts serialise through the feed -> 200, JSON number, no 500

FakeFeedRepo / helpers are copied from test_transactions_feed.py because importlib
mode gives each test file its own module namespace (no cross-file import resolves).
"""

import base64
import copy
import json
from decimal import Decimal

import pytest

ANZ = "anz-rewards-black-visa"
SPENDING = "up-spending"
HOMELOAN = "up-homeloan"


def _row(account_id, date, txn_id, **extra):
    return {
        "pk": f"ACCOUNT#{account_id}", "sk": f"TXN#{txn_id}",
        "transaction_id": txn_id, "account_id": account_id, "date": date, **extra,
    }


class FakeFeedRepo:
    """Realistic date-index newest-first query with ExclusiveStartKey resume-strictly-after.
    Copied verbatim from test_transactions_feed.py (importlib isolates test modules)."""

    def __init__(self, rows_by_account):
        self._rows = {
            account_id: sorted(rows, key=lambda r: (r["date"], r["sk"]), reverse=True)
            for account_id, rows in rows_by_account.items()
        }
        self.calls = []

    @staticmethod
    def _key(row):
        return {
            "account_id": row["account_id"], "date": row["date"],
            "pk": row["pk"], "sk": row["sk"],
        }

    def get_transactions_by_date_range(self, account_id, start_date, end_date, limit=20, cursor=None):
        self.calls.append((account_id, start_date, end_date, limit, cursor))
        rows = self._rows.get(account_id, [])
        start = 0
        if cursor is not None:
            for index, row in enumerate(rows):
                if row["pk"] == cursor["pk"] and row["sk"] == cursor["sk"]:
                    start = index + 1
                    break
        page = rows[start:start + limit]
        has_more = (start + limit) < len(rows) and bool(page)
        next_key = self._key(page[-1]) if has_more else None
        return copy.deepcopy(page), next_key


def _feed_event(params=None):
    return {
        "rawPath": "/transactions/feed",
        "requestContext": {"http": {"method": "GET"}},
        "queryStringParameters": params,
    }


def _one_page(handler, repo, cursor=None, limit=None):
    params = {}
    if limit is not None:
        params["limit"] = str(limit)
    if cursor is not None:
        params["cursor"] = cursor
    resp = handler.get_transactions_feed(_feed_event(params), repo)
    return resp


def _drain_with_limits(handler, repo, limits):
    """Page to exhaustion, cycling through `limits` per page (a list). Returns
    (all_transactions, page_count). Lets a test change the page size MID-pagination."""
    all_transactions = []
    cursor = None
    for i in range(2000):
        limit = limits[i % len(limits)]
        resp = _one_page(handler, repo, cursor=cursor, limit=limit)
        assert resp["statusCode"] == 200, resp
        body = json.loads(resp["body"])
        all_transactions.extend(body["transactions"])
        cursor = body["nextCursor"]
        if cursor is None:
            return all_transactions, i + 1
    pytest.fail("feed did not terminate — nextCursor never went null")


def _assert_history(got_txns, expected_ids):
    got_ids = [t["transaction_id"] for t in got_txns]
    assert set(got_ids) == set(expected_ids), (
        f"missing={set(expected_ids) - set(got_ids)} extra={set(got_ids) - set(expected_ids)}"
    )
    assert len(got_ids) == len(expected_ids), f"dupes present: {got_ids}"
    dates = [t["date"] for t in got_txns]
    assert dates == sorted(dates, reverse=True), f"not newest-first: {dates}"


# --- [G1] page size larger than total history -------------------------------------

def test_page_size_larger_than_total_history_is_one_page_null_cursor(handler):
    # WHIT — [G1] limit far exceeds the row count -> everything fits on page 1, null cursor.
    rows = {
        ANZ: [_row(ANZ, "2026-07-10", "a1")],
        SPENDING: [_row(SPENDING, f"2026-07-{d:02d}", f"s{d}") for d in (2, 5, 8)],
        HOMELOAN: [_row(HOMELOAN, "2026-07-06", "h1")],
    }
    repo = FakeFeedRepo(rows)
    resp = _one_page(handler, repo, limit=100)  # clamped to MAX_PAGE_SIZE, >> 5 rows
    assert resp["statusCode"] == 200
    body = json.loads(resp["body"])
    expected = [r["transaction_id"] for acc in rows.values() for r in acc]
    _assert_history(body["transactions"], expected)
    assert body["nextCursor"] is None            # single page — nothing left to resume


# --- [G2] an account exhausts mid-drain, others continue --------------------------

def test_account_exhausts_mid_drain_drops_from_cursor_others_continue(handler):
    # SPENDING holds only the two NEWEST rows; it exhausts early, yet ANZ+HOMELOAN keep
    # paging back. Nothing lost, nothing duplicated, and SPENDING must leave the cursor.
    rows = {
        SPENDING: [_row(SPENDING, "2026-07-20", "s2"), _row(SPENDING, "2026-07-19", "s1")],
        ANZ: [_row(ANZ, f"2026-07-{d:02d}", f"a{d}") for d in range(1, 11)],
        HOMELOAN: [_row(HOMELOAN, f"2026-07-{d:02d}", f"h{d}") for d in range(1, 8)],
    }
    repo = FakeFeedRepo(rows)
    expected = [r["transaction_id"] for acc in rows.values() for r in acc]

    # Walk pages manually so we can inspect the cursor the moment SPENDING is gone.
    all_txns, cursor, saw_spending_dropped = [], None, False
    for _ in range(1000):
        resp = _one_page(handler, repo, cursor=cursor, limit=2)
        assert resp["statusCode"] == 200
        body = json.loads(resp["body"])
        all_txns.extend(body["transactions"])
        cursor = body["nextCursor"]
        if cursor is not None:
            decoded = handler._decode_feed_cursor(cursor)
            # Once both SPENDING rows are shown it must not linger in the resume map.
            if all(t in {x["transaction_id"] for x in all_txns} for t in ("s1", "s2")):
                if SPENDING not in decoded:
                    saw_spending_dropped = True
        if cursor is None:
            break
    _assert_history(all_txns, expected)
    assert saw_spending_dropped, "exhausted account never left the cursor"


# --- [G3] page size changed mid-pagination ----------------------------------------

def test_page_size_change_mid_pagination_stays_gap_free(handler):
    # The gap-free proof ("<limit rows newer than a top-limit row") is a PER-PAGE argument;
    # it must survive the client changing ?limit= between pages. Cycle 1 -> 5 -> 2 -> 7.
    rows = {
        ANZ: [_row(ANZ, f"2026-06-{d:02d}", f"a{d}") for d in range(1, 14)],
        SPENDING: [_row(SPENDING, f"2026-06-{d:02d}", f"s{d}") for d in range(1, 10)],
        HOMELOAN: [_row(HOMELOAN, f"2026-06-{d:02d}", f"h{d}") for d in range(1, 5)],
    }
    repo = FakeFeedRepo(rows)
    expected = [r["transaction_id"] for acc in rows.values() for r in acc]
    got, _ = _drain_with_limits(handler, repo, [1, 5, 2, 7])
    _assert_history(got, expected)


def test_cursor_from_small_page_resumed_with_large_page(handler):
    # Concrete limit=A -> limit=B: page 1 tiny (limit=1), then a big second page. The big
    # page must pick up EXACTLY where the tiny page left off — no repeat of page-1 rows,
    # no skipped row between them.
    rows = {
        ANZ: [_row(ANZ, "2026-07-09", "a9"), _row(ANZ, "2026-07-06", "a6")],
        SPENDING: [_row(SPENDING, "2026-07-08", "s8"), _row(SPENDING, "2026-07-05", "s5")],
        HOMELOAN: [_row(HOMELOAN, "2026-07-07", "h7"), _row(HOMELOAN, "2026-07-04", "h4")],
    }
    repo = FakeFeedRepo(rows)
    page1 = json.loads(_one_page(handler, repo, limit=1)["body"])
    assert [t["transaction_id"] for t in page1["transactions"]] == ["a9"]  # newest overall
    page2 = json.loads(_one_page(handler, repo, cursor=page1["nextCursor"], limit=50)["body"])
    ids2 = [t["transaction_id"] for t in page2["transactions"]]
    assert "a9" not in ids2                                   # no repeat across the size jump
    combined = page1["transactions"] + page2["transactions"]
    expected = [r["transaction_id"] for acc in rows.values() for r in acc]
    _assert_history(combined, expected)
    assert page2["nextCursor"] is None


# --- [G4] resume on a same-date boundary within one account -----------------------

def test_same_date_run_within_one_account_split_by_size_change(handler):
    # One account, five rows all on the SAME date. A limit=2 first page splits the run; the
    # resume key lands mid-run. Resume with a different size and the rest must appear once,
    # in a stable order, none dropped or repeated.
    rows = {SPENDING: [_row(SPENDING, "2026-07-01", f"s{i}") for i in range(5)]}
    repo = FakeFeedRepo(rows)
    got, _ = _drain_with_limits(handler, repo, [2, 3])   # 2 then 3 straddles the 5-run
    expected = [r["transaction_id"] for r in rows[SPENDING]]
    _assert_history(got, expected)


def test_same_date_across_accounts_resume_boundary_with_size_change(handler):
    # Same date on all three accounts AND older tails, page size changing each page. The
    # equal-date tiebreak (ACCOUNT_ID_MAP order) must stay stable across the resume so no
    # tie-row is lost or doubled.
    rows = {
        ANZ: [_row(ANZ, "2026-07-01", "a_t"), _row(ANZ, "2026-06-01", "a_o")],
        SPENDING: [_row(SPENDING, "2026-07-01", "s_t"), _row(SPENDING, "2026-06-01", "s_o")],
        HOMELOAN: [_row(HOMELOAN, "2026-07-01", "h_t"), _row(HOMELOAN, "2026-06-01", "h_o")],
    }
    repo = FakeFeedRepo(rows)
    got, _ = _drain_with_limits(handler, repo, [1, 4, 2])
    expected = [r["transaction_id"] for acc in rows.values() for r in acc]
    _assert_history(got, expected)


# --- [G5] limit string edge cases -------------------------------------------------

def test_whitespace_padded_limit_is_accepted(handler):
    # int(" 5 ") == 5 in Python -> a padded but numeric limit is honoured, not a 400.
    repo = FakeFeedRepo({SPENDING: [_row(SPENDING, "2026-07-01", "s1")]})
    resp = handler.get_transactions_feed(_feed_event({"limit": "  5  "}), repo)
    assert resp["statusCode"] == 200
    assert all(call[3] == 5 for call in repo.calls)


def test_float_string_limit_is_400_and_never_hits_repo(handler):
    # "5.5" / "5.0" are not ints -> 400 (mirrors non-numeric), before any DynamoDB call.
    repo = FakeFeedRepo({SPENDING: [_row(SPENDING, "2026-07-01", "s1")]})
    resp = handler.get_transactions_feed(_feed_event({"limit": "5.5"}), repo)
    assert resp["statusCode"] == 400
    assert repo.calls == []


def test_whitespace_only_limit_is_400(handler):
    repo = FakeFeedRepo({SPENDING: [_row(SPENDING, "2026-07-01", "s1")]})
    resp = handler.get_transactions_feed(_feed_event({"limit": "   "}), repo)
    assert resp["statusCode"] == 400
    assert repo.calls == []


def test_negative_limit_is_clamped_to_one_not_500(handler):
    # A negative Limit is a DynamoDB ValidationException (500); the clamp turns "-3" into 1.
    # Documents CURRENT behaviour: negative is silently clamped, NOT rejected as 400.
    repo = FakeFeedRepo({SPENDING: [_row(SPENDING, "2026-07-01", "s1")]})
    resp = handler.get_transactions_feed(_feed_event({"limit": "-3"}), repo)
    assert resp["statusCode"] == 200
    assert all(call[3] == 1 for call in repo.calls)


# --- [G6] cursor decodes to valid JSON that isn't an object -----------------------

@pytest.mark.parametrize("payload", [[1, 2, 3], "just-a-string", 42, 3.14, True, None])
def test_cursor_valid_json_but_not_an_object_is_400(handler, payload):
    # base64 of a JSON list/string/number/bool/null is well-formed JSON but not the
    # {v, a} object -> must be a clean 400, never a 500 on .get()/ExclusiveStartKey.
    repo = FakeFeedRepo({SPENDING: [_row(SPENDING, "2026-07-01", "s1")]})
    forged = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode("ascii")
    resp = handler.get_transactions_feed(_feed_event({"cursor": forged}), repo)
    assert resp["statusCode"] == 400
    assert repo.calls == []


# --- [G7] large valid resume map with unknown account ids -------------------------

def test_large_resume_map_with_unknown_accounts_is_tolerated(handler):
    # A validly-shaped cursor may name accounts we no longer serve (a renamed/removed
    # account, or a client on stale config). Each must be queried, return empty, and drop
    # out — never a 500. Known accounts still page normally.
    unknown = {}
    for i in range(60):
        acc = f"ghost-account-{i}"
        unknown[acc] = {"account_id": acc, "date": "2026-07-01",
                        "pk": f"ACCOUNT#{acc}", "sk": f"TXN#g{i}"}
    resume = {SPENDING: None, ANZ: None, **unknown}
    token = handler._encode_feed_cursor(resume)

    repo = FakeFeedRepo({
        SPENDING: [_row(SPENDING, "2026-07-03", "s3"), _row(SPENDING, "2026-07-01", "s1")],
        ANZ: [_row(ANZ, "2026-07-02", "a2")],
    })
    resp = handler.get_transactions_feed(_feed_event({"cursor": token, "limit": "50"}), repo)
    assert resp["statusCode"] == 200
    body = json.loads(resp["body"])
    ids = [t["transaction_id"] for t in body["transactions"]]
    assert ids == ["s3", "a2", "s1"]                 # known accounts merged newest-first
    # Ghost accounts contributed nothing and must not linger in the next cursor.
    if body["nextCursor"] is not None:
        decoded = handler._decode_feed_cursor(body["nextCursor"])
        assert not any(a.startswith("ghost-account-") for a in decoded)
    else:
        pass  # fully drained -> no cursor at all, also fine


# --- [G8] Decimal amounts serialise through the feed ------------------------------

def test_decimal_amounts_serialise_through_feed_no_500(handler):
    # DynamoDB hands numbers back as Decimal. The feed reuses DecimalEncoder; a raw
    # json.dumps of a Decimal would raise (a 500). Assert a real JSON number comes out.
    rows = {SPENDING: [
        _row(SPENDING, "2026-07-02", "s2", amount=Decimal("-12.34"), balance=Decimal("100")),
        _row(SPENDING, "2026-07-01", "s1", amount=Decimal("0")),
    ]}
    repo = FakeFeedRepo(rows)
    resp = handler.get_transactions_feed(_feed_event({}), repo)
    assert resp["statusCode"] == 200
    body = json.loads(resp["body"])           # would raise if body weren't valid JSON
    txns = {t["transaction_id"]: t for t in body["transactions"]}
    assert txns["s2"]["amount"] == pytest.approx(-12.34)
    assert isinstance(txns["s2"]["amount"], float)
    assert txns["s1"]["amount"] == 0
