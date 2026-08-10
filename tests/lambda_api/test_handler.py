"""Tests for the lambda_api handler: PATCH /transactions/{id} and the
GET /transactions recent feed (get_recent_transactions).

The handler is provided by the `handler` fixture (see conftest.py), which imports
lambda_api/handler.py in isolation. patch_transaction and
get_recent_transactions both take the repo as a parameter, so most tests call them
directly with a fake repo — no patching, no AWS. Dispatch tests drive them through
lambda_handler to prove the wiring (and, for the feed, that its real body runs).
"""

import base64
import copy
import json
from datetime import date
from decimal import Decimal

import pytest

# _UNSET / FakeRepo / _patch_event live in tests/shared/_handler_patch_fakes.py so this impl
# suite and the two PATCH gap suites share ONE definition (WHIT-445); the batch/recent-feed
# fakes below are used only here and stay local.
from _handler_patch_fakes import FakeRepo, _patch_event


class FakeBatchRepo:
    """Stand-in for TransactionRepository's batch category write. Records the updates
    it was handed and returns a configurable per-item results list (default: every
    id 'updated'), so the handler's validation + response-shaping is what's tested."""

    def __init__(self, results=None):
        self._results = results
        self.batch_calls = []

    def update_transaction_categories(self, updates):
        self.batch_calls.append(updates)
        if self._results is not None:
            return self._results
        return [{"id": u["id"], "status": "updated"} for u in updates]


def _batch_event(body, is_b64=False):
    return {
        "rawPath": "/transactions",
        "requestContext": {"http": {"method": "PATCH"}},
        "body": body,
        "isBase64Encoded": is_b64,
    }


class FakeRecentFeedRepo:
    """Stand-in for TransactionRepository for get_recent_transactions.

    Serves per-account queued (items, cursor) pages, mirroring the real
    get_transactions_by_date_range(account_id, start, end, limit, cursor) ->
    (items, LastEvaluatedKey) contract. Records every call (so window/pagination
    assertions can inspect the args) and hands out DEEP COPIES, because the
    function mutates rows in place (pop pk/sk, setdefault category) — sharing
    references would let one call's edits corrupt the seed or a later page.
    """

    def __init__(self, pages_by_account=None):
        # pages_by_account: {account_id: [(items, cursor), ...]}
        self._pages = {a: list(p) for a, p in (pages_by_account or {}).items()}
        self.calls = []

    def get_transactions_by_date_range(
        self, account_id, start_date, end_date, limit=20, cursor=None
    ):
        self.calls.append((account_id, start_date, end_date, limit, cursor))
        queue = self._pages.get(account_id)
        if queue:
            items, next_cursor = queue.pop(0)
            return copy.deepcopy(items), next_cursor
        return [], None


def _row(account_id, date, txn_id, **extra):
    """A stored transaction row as the date-index query would return it."""
    return {
        "pk": f"ACCOUNT#{account_id}", "sk": f"TXN#{txn_id}",
        "transaction_id": txn_id, "account_id": account_id, "date": date, **extra,
    }


# --- happy path (repo injected directly, no patching) ------------------------


def test_patch_success_persists_category(handler):
    repo = FakeRepo(keys={"pk": "ACCOUNT#up-spending", "sk": "TXN#txn-1"})

    resp = handler.patch_transaction(_patch_event(), repo)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"transaction_id": "txn-1", "category": "groceries"}
    # persisted against the keys the resolver returned, with only the given field.
    assert repo.update_calls == [("ACCOUNT#up-spending", "TXN#txn-1", {"category": "groceries"})]


def test_patch_decodes_base64_body(handler):
    repo = FakeRepo(keys={"pk": "p", "sk": "s"})
    encoded = base64.b64encode(b'{"category": "coffee"}').decode()

    resp = handler.patch_transaction(_patch_event(body=encoded, is_b64=True), repo)

    assert resp["statusCode"] == 200
    assert repo.update_calls == [("p", "s", {"category": "coffee"})]


# --- 404s --------------------------------------------------------------------


def test_patch_unknown_id_returns_404_without_writing(handler):
    repo = FakeRepo(keys=None)

    resp = handler.patch_transaction(_patch_event(), repo)

    assert resp["statusCode"] == 404
    assert repo.update_calls == []  # never attempt the write if the id doesn't resolve


def test_patch_row_vanished_returns_404(handler):
    # get_transaction_keys_by_id found keys, but the conditional write failed
    # (row deleted in between) -> update returns False -> 404, not 500.
    repo = FakeRepo(keys={"pk": "p", "sk": "s"}, update_result=False)

    resp = handler.patch_transaction(_patch_event(), repo)

    assert resp["statusCode"] == 404


def test_patch_missing_path_id_returns_404(handler):
    event = _patch_event()
    event["pathParameters"] = {}  # no id

    resp = handler.patch_transaction(event, FakeRepo(keys={"pk": "p", "sk": "s"}))

    assert resp["statusCode"] == 404


# --- 400s --------------------------------------------------------------------


def test_patch_invalid_json_returns_400(handler):
    resp = handler.patch_transaction(_patch_event(body="not json"),
                                              FakeRepo(keys={"pk": "p", "sk": "s"}))
    assert resp["statusCode"] == 400


def test_patch_base64_non_utf8_body_returns_400(handler):
    # Valid base64, but the decoded bytes aren't UTF-8 — must be a clean 400, not a 500.
    encoded = base64.b64encode(b"\xff\xfe\xff").decode()

    resp = handler.patch_transaction(_patch_event(body=encoded, is_b64=True),
                                              FakeRepo(keys={"pk": "p", "sk": "s"}))
    assert resp["statusCode"] == 400


def test_patch_non_dict_body_returns_400(handler):
    resp = handler.patch_transaction(_patch_event(body="[1, 2, 3]"),
                                              FakeRepo(keys={"pk": "p", "sk": "s"}))
    assert resp["statusCode"] == 400


def test_patch_missing_category_returns_400(handler):
    resp = handler.patch_transaction(_patch_event(body='{"note": "x"}'),
                                              FakeRepo(keys={"pk": "p", "sk": "s"}))
    assert resp["statusCode"] == 400


def test_patch_blank_category_returns_400(handler):
    resp = handler.patch_transaction(_patch_event(body='{"category": "   "}'),
                                              FakeRepo(keys={"pk": "p", "sk": "s"}))
    assert resp["statusCode"] == 400


# --- notes & tags PATCH (WHIT-275) -------------------------------------------


def test_patch_notes_only_trims_persists_and_echoes(handler):
    repo = FakeRepo(keys={"pk": "p", "sk": "s"})
    resp = handler.patch_transaction(_patch_event(body='{"notes": "  lunch with sam  "}'), repo)
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"transaction_id": "txn-1", "notes": "lunch with sam"}
    assert repo.update_calls == [("p", "s", {"notes": "lunch with sam"})]


def test_patch_tags_only_trims_drops_empty_and_dedupes_keeping_first_casing(handler):
    repo = FakeRepo(keys={"pk": "p", "sk": "s"})
    resp = handler.patch_transaction(_patch_event(body='{"tags": ["Work", " work ", "travel", "  "]}'), repo)
    assert resp["statusCode"] == 200
    # "work" is a case-insensitive dup of "Work" (first-seen casing kept); "" is dropped.
    assert json.loads(resp["body"])["tags"] == ["Work", "travel"]
    assert repo.update_calls == [("p", "s", {"tags": ["Work", "travel"]})]


def test_patch_category_notes_and_tags_in_one_request(handler):
    repo = FakeRepo(keys={"pk": "p", "sk": "s"})
    resp = handler.patch_transaction(
        _patch_event(body='{"category": "food", "notes": "n", "tags": ["a"]}'), repo)
    assert resp["statusCode"] == 200
    assert repo.update_calls == [("p", "s", {"category": "food", "notes": "n", "tags": ["a"]})]


def test_patch_clearing_note_is_allowed(handler):
    # Unlike category, a null/empty note clears the field (server REMOVEs it).
    repo = FakeRepo(keys={"pk": "p", "sk": "s"})
    resp = handler.patch_transaction(_patch_event(body='{"notes": null}'), repo)
    assert resp["statusCode"] == 200
    assert repo.update_calls == [("p", "s", {"notes": ""})]


def test_patch_clearing_tags_is_allowed(handler):
    repo = FakeRepo(keys={"pk": "p", "sk": "s"})
    resp = handler.patch_transaction(_patch_event(body='{"tags": []}'), repo)
    assert resp["statusCode"] == 200
    assert repo.update_calls == [("p", "s", {"tags": []})]


def test_patch_empty_body_returns_400(handler):
    repo = FakeRepo(keys={"pk": "p", "sk": "s"})
    resp = handler.patch_transaction(_patch_event(body='{}'), repo)
    assert resp["statusCode"] == 400
    assert repo.update_calls == []  # nothing to change → never write


# --- budget_excluded override PATCH (WHIT-296) -------------------------------


def test_patch_budget_excluded_true_persists_and_echoes(handler):
    repo = FakeRepo(keys={"pk": "p", "sk": "s"})
    resp = handler.patch_transaction(_patch_event(body='{"budget_excluded": true}'), repo)
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"transaction_id": "txn-1", "budget_excluded": True}
    assert repo.update_calls == [("p", "s", {"budget_excluded": True})]


def test_patch_budget_excluded_false_is_allowed_and_satisfies_required(handler):
    # A bare {budget_excluded: false} is a valid patch (clears the override); it must
    # NOT trip the "at least one field required" 400 just because the value is falsy.
    repo = FakeRepo(keys={"pk": "p", "sk": "s"})
    resp = handler.patch_transaction(_patch_event(body='{"budget_excluded": false}'), repo)
    assert resp["statusCode"] == 200
    assert repo.update_calls == [("p", "s", {"budget_excluded": False})]


def test_patch_budget_excluded_non_bool_returns_400(handler):
    # A string/number is rejected — only a JSON boolean is a valid override value.
    repo = FakeRepo(keys={"pk": "p", "sk": "s"})
    for bad in ('{"budget_excluded": "true"}', '{"budget_excluded": 1}'):
        resp = handler.patch_transaction(_patch_event(body=bad), repo)
        assert resp["statusCode"] == 400
    assert repo.update_calls == []  # never written


def test_patch_note_too_long_returns_400(handler):
    repo = FakeRepo(keys={"pk": "p", "sk": "s"})
    body = json.dumps({"notes": "x" * (handler.NOTE_MAX_LEN + 1)})
    resp = handler.patch_transaction(_patch_event(body=body), repo)
    assert resp["statusCode"] == 400
    assert repo.update_calls == []


def test_patch_too_many_tags_returns_400(handler):
    repo = FakeRepo(keys={"pk": "p", "sk": "s"})
    body = json.dumps({"tags": [f"t{i}" for i in range(handler.TAG_MAX_COUNT + 1)]})
    resp = handler.patch_transaction(_patch_event(body=body), repo)
    assert resp["statusCode"] == 400
    assert repo.update_calls == []


def test_patch_tag_too_long_returns_400(handler):
    repo = FakeRepo(keys={"pk": "p", "sk": "s"})
    body = json.dumps({"tags": ["x" * (handler.TAG_MAX_LEN + 1)]})
    resp = handler.patch_transaction(_patch_event(body=body), repo)
    assert resp["statusCode"] == 400


def test_patch_non_string_tag_returns_400(handler):
    resp = handler.patch_transaction(_patch_event(body='{"tags": [1, 2]}'),
                                     FakeRepo(keys={"pk": "p", "sk": "s"}))
    assert resp["statusCode"] == 400


def test_patch_tags_not_a_list_returns_400(handler):
    resp = handler.patch_transaction(_patch_event(body='{"tags": "work"}'),
                                     FakeRepo(keys={"pk": "p", "sk": "s"}))
    assert resp["statusCode"] == 400


def test_patch_notes_non_string_returns_400(handler):
    resp = handler.patch_transaction(_patch_event(body='{"notes": 5}'),
                                     FakeRepo(keys={"pk": "p", "sk": "s"}))
    assert resp["statusCode"] == 400


def test_patch_notes_unknown_id_returns_404_without_writing(handler):
    repo = FakeRepo(keys=None)
    resp = handler.patch_transaction(_patch_event(body='{"notes": "x"}'), repo)
    assert resp["statusCode"] == 404
    assert repo.update_calls == []


def test_patch_notes_row_vanished_returns_404(handler):
    repo = FakeRepo(keys={"pk": "p", "sk": "s"}, update_result=False)
    resp = handler.patch_transaction(_patch_event(body='{"notes": "x"}'), repo)
    assert resp["statusCode"] == 404


# --- batch PATCH /transactions (WHIT-70) -------------------------------------


def test_batch_success_applies_all_and_shapes_results(handler):
    repo = FakeBatchRepo()
    body = '{"updates": [{"id": "t1", "category": "coffee"}, {"id": "t2", "category": "coffee"}]}'

    resp = handler.patch_transactions_batch(_batch_event(body), repo)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {
        "results": [{"id": "t1", "status": "updated"}, {"id": "t2", "status": "updated"}]
    }
    # The handler forwarded exactly the parsed updates to the repo (one call).
    assert repo.batch_calls == [[{"id": "t1", "category": "coffee"}, {"id": "t2", "category": "coffee"}]]


def test_batch_passes_through_per_item_status(handler):
    # A mixed result (one unknown id) is the repo's call; the handler returns it as-is.
    repo = FakeBatchRepo(results=[{"id": "t1", "status": "updated"}, {"id": "gone", "status": "not_found"}])
    body = '{"updates": [{"id": "t1", "category": "coffee"}, {"id": "gone", "category": "coffee"}]}'

    resp = handler.patch_transactions_batch(_batch_event(body), repo)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"])["results"] == [
        {"id": "t1", "status": "updated"}, {"id": "gone", "status": "not_found"}
    ]


def test_batch_decodes_base64_body(handler):
    repo = FakeBatchRepo()
    encoded = base64.b64encode(b'{"updates": [{"id": "t1", "category": "coffee"}]}').decode()

    resp = handler.patch_transactions_batch(_batch_event(encoded, is_b64=True), repo)

    assert resp["statusCode"] == 200
    assert repo.batch_calls == [[{"id": "t1", "category": "coffee"}]]


def test_batch_missing_updates_returns_400(handler):
    repo = FakeBatchRepo()
    resp = handler.patch_transactions_batch(_batch_event('{"note": "x"}'), repo)
    assert resp["statusCode"] == 400
    assert repo.batch_calls == []   # never reached the repo


def test_batch_empty_updates_returns_400(handler):
    resp = handler.patch_transactions_batch(_batch_event('{"updates": []}'), FakeBatchRepo())
    assert resp["statusCode"] == 400


def test_batch_updates_not_a_list_returns_400(handler):
    resp = handler.patch_transactions_batch(_batch_event('{"updates": "t1"}'), FakeBatchRepo())
    assert resp["statusCode"] == 400


def test_batch_oversized_returns_400(handler):
    # TRANSACTION_BATCH_MAX + 1 items is rejected before any write.
    n = handler.TRANSACTION_BATCH_MAX + 1
    items = ", ".join(f'{{"id": "t{i}", "category": "coffee"}}' for i in range(n))
    repo = FakeBatchRepo()
    resp = handler.patch_transactions_batch(_batch_event(f'{{"updates": [{items}]}}'), repo)
    assert resp["statusCode"] == 400
    assert repo.batch_calls == []


def test_batch_item_not_object_returns_400(handler):
    resp = handler.patch_transactions_batch(_batch_event('{"updates": [1, 2]}'), FakeBatchRepo())
    assert resp["statusCode"] == 400


def test_batch_item_missing_id_returns_400(handler):
    resp = handler.patch_transactions_batch(_batch_event('{"updates": [{"category": "coffee"}]}'), FakeBatchRepo())
    assert resp["statusCode"] == 400


def test_batch_item_blank_category_returns_400(handler):
    resp = handler.patch_transactions_batch(_batch_event('{"updates": [{"id": "t1", "category": "   "}]}'), FakeBatchRepo())
    assert resp["statusCode"] == 400


def test_batch_invalid_json_returns_400(handler):
    resp = handler.patch_transactions_batch(_batch_event("not json"), FakeBatchRepo())
    assert resp["statusCode"] == 400


def test_batch_exactly_max_succeeds(handler):
    # Boundary on the OTHER side of the >MAX reject: exactly TRANSACTION_BATCH_MAX
    # items must be ACCEPTED and reach the repo (a `>=` would wrongly 400 a full batch).
    n = handler.TRANSACTION_BATCH_MAX
    updates = [{"id": f"t{i}", "category": "coffee"} for i in range(n)]
    repo = FakeBatchRepo()

    resp = handler.patch_transactions_batch(_batch_event(json.dumps({"updates": updates})), repo)

    assert resp["statusCode"] == 200
    assert len(repo.batch_calls[0]) == n
    assert len(json.loads(resp["body"])["results"]) == n


# --- dispatch / regression (through lambda_handler) --------------------------


def test_batch_dispatches_and_does_not_hit_single_handler(handler, monkeypatch):
    # PATCH /transactions (collection) must route to the batch handler, NOT the
    # /{id} item handler. Guards against a future startswith broadening swallowing it.
    repo = FakeBatchRepo()
    monkeypatch.setattr(handler, "TransactionRepository", lambda: repo)
    monkeypatch.setattr(handler, "patch_transaction",
                        lambda *a, **k: pytest.fail("collection PATCH reached the item handler"))

    resp = handler.lambda_handler(_batch_event('{"updates": [{"id": "t1", "category": "coffee"}]}'), None)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"results": [{"id": "t1", "status": "updated"}]}
    assert repo.batch_calls == [[{"id": "t1", "category": "coffee"}]]


def test_patch_dispatches_through_lambda_handler(handler, monkeypatch):
    # Proves lambda_handler routes PATCH /transactions/{id} and passes a repo in.
    repo = FakeRepo(keys={"pk": "p", "sk": "s"})
    monkeypatch.setattr(handler, "TransactionRepository", lambda: repo)

    resp = handler.lambda_handler(_patch_event(), None)

    assert resp["statusCode"] == 200
    assert repo.update_calls == [("p", "s", {"category": "groceries"})]


def test_get_transactions_still_dispatches(handler, monkeypatch):
    monkeypatch.setattr(handler, "TransactionRepository", lambda: object())
    monkeypatch.setattr(handler, "get_recent_transactions", lambda repo: [{"id": 1}])

    event = {"rawPath": "/transactions", "requestContext": {"http": {"method": "GET"}}}
    resp = handler.lambda_handler(event, None)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == [{"id": 1}]


def test_unknown_route_returns_404(handler):
    event = {"rawPath": "/nope", "requestContext": {"http": {"method": "GET"}}}
    resp = handler.lambda_handler(event, None)
    assert resp["statusCode"] == 404


# --- GET /transactions recent feed (get_recent_transactions) -----------------
# The function body was previously monkeypatched away in the dispatch test, so
# none of this ran. These exercise it directly against a fake repo.


def test_recent_merges_across_all_accounts(handler):
    # One distinct row on EVERY account -> each must contribute exactly one row.
    # (A loop that skips accounts would drop one and fail this.)
    accounts = list(handler.ACCOUNT_ID_MAP.values())
    repo = FakeRecentFeedRepo(pages_by_account={
        a: [([_row(a, f"2026-07-0{i + 1}", f"t{i}")], None)]
        for i, a in enumerate(accounts)
    })

    result = handler.get_recent_transactions(repo)

    assert {t["account_id"] for t in result} == set(accounts)
    assert len(result) == len(accounts)


def test_recent_sorted_newest_first_across_accounts(handler):
    # Interleave dates across accounts so the raw concatenation is NOT already
    # sorted -> only a real descending sort produces the expected order. Guards
    # against the sort being dropped or its reverse flag flipped.
    a, b, c = list(handler.ACCOUNT_ID_MAP.values())[:3]
    repo = FakeRecentFeedRepo(pages_by_account={
        a: [([_row(a, "2026-07-04", "a2"), _row(a, "2026-07-01", "a1")], None)],
        b: [([_row(b, "2026-07-02", "b1")], None)],
        c: [([_row(c, "2026-07-03", "c1")], None)],
    })

    result = handler.get_recent_transactions(repo)

    assert [t["date"] for t in result] == [
        "2026-07-04", "2026-07-03", "2026-07-02", "2026-07-01",
    ]


def test_recent_strips_pk_and_sk(handler):
    a = list(handler.ACCOUNT_ID_MAP.values())[0]
    repo = FakeRecentFeedRepo(pages_by_account={a: [([_row(a, "2026-07-01", "t1")], None)]})

    result = handler.get_recent_transactions(repo)

    assert result
    assert all("pk" not in t and "sk" not in t for t in result)


def test_recent_defaults_missing_category_and_preserves_present(handler):
    # Missing category -> None; a real category is left untouched. The "present"
    # half catches a regression from setdefault to a plain `= None` assignment.
    a, b = list(handler.ACCOUNT_ID_MAP.values())[:2]
    repo = FakeRecentFeedRepo(pages_by_account={
        a: [([_row(a, "2026-07-02", "with_cat", category="coffee")], None)],
        b: [([_row(b, "2026-07-01", "no_cat")], None)],
    })

    by_id = {t["transaction_id"]: t for t in handler.get_recent_transactions(repo)}

    assert by_id["with_cat"]["category"] == "coffee"
    assert by_id["no_cat"]["category"] is None


def test_recent_paginates_all_pages_per_account(handler):
    # >1 page for an account: the feed must follow the cursor to exhaustion, not
    # stop at page 1. FAILS against the old discard-the-cursor code, passes now.
    a = list(handler.ACCOUNT_ID_MAP.values())[0]
    repo = FakeRecentFeedRepo(pages_by_account={
        a: [
            ([_row(a, "2026-07-01", "page1")], {"pk": "x", "sk": "y"}),  # more to come
            ([_row(a, "2026-07-02", "page2")], None),                    # last page
        ],
    })

    result = handler.get_recent_transactions(repo)

    assert {t["transaction_id"] for t in result} == {"page1", "page2"}


def test_recent_window_is_feed_window_days_on_melbourne_clock(handler, monkeypatch):
    # Freeze today (Melbourne-local, the same clock the budget window uses) and
    # assert the recorded query bounds against LITERAL dates (an independent
    # oracle): start = today - FEED_WINDOW_DAYS(7), end = today (INCLUSIVE, no
    # today+1). Literals catch a reintroduced +1 or a changed window that a
    # recomputed expression would silently mirror.
    monkeypatch.setattr(handler, "_melbourne_today", lambda: date(2026, 7, 3))
    a = list(handler.ACCOUNT_ID_MAP.values())[0]
    repo = FakeRecentFeedRepo(pages_by_account={a: [([_row(a, "2026-07-01", "t1")], None)]})

    handler.get_recent_transactions(repo)

    assert {c[1] for c in repo.calls} == {"2026-06-26"}  # 2026-07-03 minus 7 days
    assert {c[2] for c in repo.calls} == {"2026-07-03"}  # today, inclusive (no +1 leak)


def test_recent_window_reads_the_feed_window_days_constant(handler, monkeypatch):
    # Prove the window is wired to FEED_WINDOW_DAYS, not a hardcoded 7: patch the
    # constant to 3 and the start bound must move with it.
    monkeypatch.setattr(handler, "_melbourne_today", lambda: date(2026, 7, 3))
    monkeypatch.setattr(handler, "FEED_WINDOW_DAYS", 3)
    a = list(handler.ACCOUNT_ID_MAP.values())[0]
    repo = FakeRecentFeedRepo(pages_by_account={a: [([_row(a, "2026-07-01", "t1")], None)]})

    handler.get_recent_transactions(repo)

    assert {c[1] for c in repo.calls} == {"2026-06-30"}  # today - 3 days


def test_recent_row_missing_date_raises_keyerror(handler):
    # Contract: every returned row carries `date` (the date-index sort key the
    # query filters on). A dateless row is a data-integrity violation -> fail fast
    # rather than silently mis-sort. Documented, not hardened (unreachable via the
    # real repo, which can only return rows matching the date range).
    a = list(handler.ACCOUNT_ID_MAP.values())[0]
    dateless = {
        "pk": f"ACCOUNT#{a}", "sk": "TXN#x", "transaction_id": "x", "account_id": a,
    }
    repo = FakeRecentFeedRepo(pages_by_account={a: [([dateless], None)]})

    with pytest.raises(KeyError):
        handler.get_recent_transactions(repo)


def test_recent_empty_feed_returns_empty_list(handler):
    assert handler.get_recent_transactions(FakeRecentFeedRepo()) == []


def test_recent_one_empty_account_still_returns_the_others(handler):
    a = list(handler.ACCOUNT_ID_MAP.values())[0]  # only this account has rows
    repo = FakeRecentFeedRepo(pages_by_account={a: [([_row(a, "2026-07-01", "t1")], None)]})

    result = handler.get_recent_transactions(repo)

    assert [t["transaction_id"] for t in result] == ["t1"]


def test_get_transactions_dispatch_runs_real_body(handler, monkeypatch):
    # The card's core gap: the real get_recent_transactions body runs end-to-end
    # through lambda_handler (NOT monkeypatched away), proving routing plus JSON
    # serialisation of Decimal amounts via DecimalEncoder.
    a = list(handler.ACCOUNT_ID_MAP.values())[0]
    repo = FakeRecentFeedRepo(pages_by_account={
        a: [([_row(a, "2026-07-01", "t1", amount=Decimal("-12.50"), category="coffee")], None)],
    })
    monkeypatch.setattr(handler, "TransactionRepository", lambda: repo)

    event = {"rawPath": "/transactions", "requestContext": {"http": {"method": "GET"}}}
    resp = handler.lambda_handler(event, None)

    assert resp["statusCode"] == 200
    body = json.loads(resp["body"])
    assert len(body) == 1
    assert body[0]["transaction_id"] == "t1"
    assert body[0]["amount"] == -12.5  # Decimal serialised as a JSON number
    assert "pk" not in body[0] and "sk" not in body[0]


# --- recent feed: adversarial gap tests (qa) ---------------------------------


def test_recent_paginates_every_account_to_exhaustion(handler):
    # Extends the single-account pagination test to TWO accounts: proves each account
    # is paginated to exhaustion independently, every account's first query starts at
    # cursor=None, and the feed queries at limit=MAX_PAGE_SIZE (not the default 20).
    a, b = list(handler.ACCOUNT_ID_MAP.values())[:2]
    repo = FakeRecentFeedRepo(pages_by_account={
        a: [
            ([_row(a, "2026-07-01", "a_p1")], {"cur": "a1"}),
            ([_row(a, "2026-07-02", "a_p2")], None),
        ],
        b: [
            ([_row(b, "2026-07-01", "b_p1")], {"cur": "b1"}),
            ([_row(b, "2026-07-02", "b_p2")], None),
        ],
    })

    result = handler.get_recent_transactions(repo)

    assert {t["transaction_id"] for t in result} == {"a_p1", "a_p2", "b_p1", "b_p2"}
    by_acct = {}
    for account_id, _s, _e, limit, cursor in repo.calls:
        by_acct.setdefault(account_id, []).append(cursor)
        assert limit == handler.MAX_PAGE_SIZE
    assert by_acct[a] == [None, {"cur": "a1"}]  # each account starts fresh (None)
    assert by_acct[b] == [None, {"cur": "b1"}]


def test_recent_empty_page_with_cursor_still_follows_to_next_page(handler):
    # DynamoDB can return Items=[] with a non-null LastEvaluatedKey (a segment whose
    # rows were all filtered out). The loop must break on a falsy CURSOR, not an
    # empty page — a naive `if not page: break` would drop the row on the next page.
    a = list(handler.ACCOUNT_ID_MAP.values())[0]
    repo = FakeRecentFeedRepo(pages_by_account={
        a: [
            ([], {"cur": "keep-going"}),
            ([_row(a, "2026-07-02", "after_empty")], None),
        ],
    })

    result = handler.get_recent_transactions(repo)

    assert [t["transaction_id"] for t in result] == ["after_empty"]
    assert [c[4] for c in repo.calls if c[0] == a] == [None, {"cur": "keep-going"}]


def test_recent_ties_on_identical_date_preserve_fetch_order(handler):
    # All rows share ONE date. sorted(reverse=True) is stable, so equal-date rows
    # keep fetch order (account-map order, then page order). Catches a regression
    # that adds an unstable secondary key or reverses ties.
    a, b, c = list(handler.ACCOUNT_ID_MAP.values())[:3]
    repo = FakeRecentFeedRepo(pages_by_account={
        a: [
            ([_row(a, "2026-07-01", "a_p1")], {"cur": "a1"}),
            ([_row(a, "2026-07-01", "a_p2")], None),
        ],
        b: [([_row(b, "2026-07-01", "b1")], None)],
        c: [([_row(c, "2026-07-01", "c1")], None)],
    })

    result = handler.get_recent_transactions(repo)

    assert [t["transaction_id"] for t in result] == ["a_p1", "a_p2", "b1", "c1"]


def test_recent_returns_pending_and_posted_without_filtering(handler):
    # The feed is a raw window view — it must NOT filter by status. Both a posted
    # and a pending row survive with status intact. Fails if a status filter slips in.
    a = list(handler.ACCOUNT_ID_MAP.values())[0]
    repo = FakeRecentFeedRepo(pages_by_account={
        a: [([
            _row(a, "2026-07-02", "posted1", status="posted"),
            _row(a, "2026-07-01", "pending1", status="pending"),
        ], None)],
    })

    by_id = {t["transaction_id"]: t for t in handler.get_recent_transactions(repo)}

    assert by_id["posted1"]["status"] == "posted"
    assert by_id["pending1"]["status"] == "pending"


def test_recent_tomorrow_dated_row_sorts_first(handler):
    # The +1 end fudge admits a tomorrow-dated (AEST-ahead) row; it must sort to the
    # top. Fails if the descending sort's reverse flag is flipped. (Whether such a
    # row is INCLUDED is the repo's between-filter concern, tested there.)
    a = list(handler.ACCOUNT_ID_MAP.values())[0]
    repo = FakeRecentFeedRepo(pages_by_account={
        a: [([
            _row(a, "2026-07-03", "today"),
            _row(a, "2026-07-04", "tomorrow"),
        ], None)],
    })

    result = handler.get_recent_transactions(repo)

    assert [t["transaction_id"] for t in result] == ["tomorrow", "today"]


# --- _fetch_windowed_transactions: bounded pagination (WHIT-102) --------------


def test_fetch_windowed_transactions_aborts_on_nonterminating_cursor(handler):
    # A repo whose cursor is NEVER null must not spin forever: the per-account loop
    # is bounded, so it raises loudly instead of hanging to the Lambda timeout.
    # Without the cap this test would hang; with it, it raises at the ceiling.
    class _NeverEndingRepo:
        def __init__(self):
            self.calls = 0

        def get_transactions_by_date_range(
            self, account_id, start, end, limit=20, cursor=None
        ):
            self.calls += 1
            return [_row(account_id, "2026-07-01", f"t{self.calls}")], {"cur": self.calls}

    repo = _NeverEndingRepo()

    with pytest.raises(RuntimeError, match="did not terminate"):
        handler._fetch_windowed_transactions(repo, "2026-06-26", "2026-07-04")

    # Stopped exactly at the ceiling (the first account trips it), not later.
    assert repo.calls == handler._MAX_PAGES_PER_ACCOUNT


def test_fetch_windowed_transactions_terminates_normally_within_the_cap(handler):
    # A well-behaved repo (cursor -> None) returns all rows and never approaches the
    # ceiling — the guard doesn't interfere with normal pagination.
    a = list(handler.ACCOUNT_ID_MAP.values())[0]
    repo = FakeRecentFeedRepo(pages_by_account={
        a: [
            ([_row(a, "2026-07-01", "p1")], {"cur": 1}),
            ([_row(a, "2026-07-02", "p2")], None),
        ],
    })

    result = handler._fetch_windowed_transactions(repo, "2026-06-26", "2026-07-04")

    assert {t["transaction_id"] for t in result} == {"p1", "p2"}


# === WHIT-275 adversarial gaps: patch_transaction notes/tags boundaries (folded from
# test_handler_whit275_gaps.py) — the EXACT-boundary passes, dedupe-then-cap ordering, and
# the partial-write guard the over-limit rejection tests above don't cover. =================


# --- exact-boundary passes (implementer only tests one-over) -----------------


def test_patch_note_exactly_at_max_len_is_accepted(handler):  # [A6]
    repo = FakeRepo(keys={"pk": "p", "sk": "s"})
    note = "x" * handler.NOTE_MAX_LEN
    resp = handler.patch_transaction(_patch_event(body=json.dumps({"notes": note})), repo)
    assert resp["statusCode"] == 200
    assert repo.update_calls == [("p", "s", {"notes": note})]


def test_patch_tag_exactly_at_max_len_is_accepted(handler):  # [A7]
    repo = FakeRepo(keys={"pk": "p", "sk": "s"})
    tag = "y" * handler.TAG_MAX_LEN
    resp = handler.patch_transaction(_patch_event(body=json.dumps({"tags": [tag]})), repo)
    assert resp["statusCode"] == 200
    assert repo.update_calls == [("p", "s", {"tags": [tag]})]


def test_patch_exactly_max_count_tags_is_accepted(handler):  # [A8]
    repo = FakeRepo(keys={"pk": "p", "sk": "s"})
    tags = [f"t{i}" for i in range(handler.TAG_MAX_COUNT)]
    resp = handler.patch_transaction(_patch_event(body=json.dumps({"tags": tags})), repo)
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"])["tags"] == tags


# --- dedupe happens BEFORE the count cap -------------------------------------


def test_patch_over_max_raw_tags_that_dedupe_under_the_cap_are_accepted(handler):  # [A9]
    # 20 unique + 10 case-insensitive dups = 30 raw, 20 survive dedupe. The cap is on
    # the CLEANED count, so this is a 200 — proving the count check runs after dedupe.
    unique = [f"t{i}" for i in range(handler.TAG_MAX_COUNT)]
    raw = unique + [t.upper() for t in unique[:10]]
    repo = FakeRepo(keys={"pk": "p", "sk": "s"})
    resp = handler.patch_transaction(_patch_event(body=json.dumps({"tags": raw})), repo)
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"])["tags"] == unique  # first-seen casing kept


# --- partial-write guard: one bad field rejects the WHOLE request ------------


def test_patch_blank_category_with_valid_notes_400s_and_writes_nothing(handler):  # [A10]
    repo = FakeRepo(keys={"pk": "p", "sk": "s"})
    resp = handler.patch_transaction(
        _patch_event(body='{"category": "  ", "notes": "keep me"}'), repo)
    assert resp["statusCode"] == 400
    assert repo.update_calls == []  # the good note must NOT be partially persisted


def test_patch_bad_tag_with_valid_notes_400s_and_writes_nothing(handler):  # [A11]
    repo = FakeRepo(keys={"pk": "p", "sk": "s"})
    resp = handler.patch_transaction(
        _patch_event(body='{"notes": "keep me", "tags": [1]}'), repo)
    assert resp["statusCode"] == 400
    assert repo.update_calls == []


# === WHIT-296 adversarial gaps: PATCH budget_excluded validation (folded from
# test_handler_whit296_gaps.py) — a JSON null override, and budget_excluded co-present with
# category in one write. (true/false/string/int are covered above, not duplicated.) ========


def test_patch_budget_excluded_null_returns_400(handler):
    # [A-H1] JSON null is not a bool -> 400, never written (someone might expect null
    # to clear; the API's clear signal is `false`, and null must not slip through as
    # a stored None). isinstance(None, bool) is False, so the guard rejects it.
    repo = FakeRepo(keys={"pk": "p", "sk": "s"})
    resp = handler.patch_transaction(_patch_event(body='{"budget_excluded": null}'), repo)
    assert resp["statusCode"] == 400
    assert repo.update_calls == []


def test_patch_budget_excluded_alongside_category_applies_both(handler):
    # [A-H2] A single PATCH carrying category AND budget_excluded writes both in one
    # call and echoes both — adding the override branch to the validator must not drop
    # a co-present field. Fail-on-revert: remove the budget_excluded validator block
    # and the echo/write loses it.
    repo = FakeRepo(keys={"pk": "p", "sk": "s"})
    resp = handler.patch_transaction(
        _patch_event(body='{"category": "groceries", "budget_excluded": true}'), repo)
    assert resp["statusCode"] == 200
    body = json.loads(resp["body"])
    assert body["category"] == "groceries"
    assert body["budget_excluded"] is True
    assert repo.update_calls == [("p", "s", {"category": "groceries", "budget_excluded": True})]
