"""Tests for the lambda_api handler: PATCH /transactions/{id} and the
GET /transactions recent feed (get_recent_transactions).

The handler is provided by the `handler` fixture (see conftest.py), which imports
lambda_api/handler.py in isolation. patch_transaction and
get_recent_transactions both take the repo as a parameter, so most tests call them
directly with a fake repo — no patching, no AWS. Dispatch tests drive them through
lambda_handler to prove the wiring (and, for the feed, that its real body runs).
"""

import base64
import json
from datetime import date
from decimal import Decimal

import pytest

# _UNSET / FakeRepo / _patch_event live in tests/shared/_handler_patch_fakes.py so this impl
# suite and the two PATCH gap suites share ONE definition (WHIT-445); the batch fake below
# is used only here and stays local.
from _api_event import api_event
from _handler_patch_fakes import FakeRepo, _patch_event
from _lambda_api_constants import api_constant
from _transaction_range_fakes import _AccountPagesTransactionRepo


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
    return api_event("PATCH", "/transactions", raw=body, is_base64=is_b64)


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


# --- 400s --------------------------------------------------------------------
# This table and test_patch_decodes_base64_body are the one home for request-body parsing
# (base64 / invalid JSON / non-object), which every route shares.


def _too_long_note(handler):
    return json.dumps({"notes": "x" * (handler.NOTE_MAX_LEN + 1)})


def _too_many_tags(handler):
    return json.dumps({"tags": [f"t{i}" for i in range(handler.TAG_MAX_COUNT + 1)]})


def _too_long_tag(handler):
    return json.dumps({"tags": ["x" * (handler.TAG_MAX_LEN + 1)]})


@pytest.mark.parametrize(("body", "is_b64"), [
    ("not json", False),
    (base64.b64encode(b"\xff\xfe\xff").decode(), True),     # valid base64, not UTF-8
    ("[1, 2, 3]", False),
    ('{"note": "x"}', False),                               # no known field
    ('{"category": "   "}', False),
    ("{}", False),
    ('{"budget_excluded": "true"}', False),
    ('{"budget_excluded": 1}', False),
    ('{"budget_excluded": null}', False),                   # the clear signal is false, not null
    (_too_long_note, False),
    (_too_many_tags, False),
    (_too_long_tag, False),
    ('{"tags": [1, 2]}', False),
    ('{"tags": "work"}', False),
    ('{"notes": 5}', False),
    # One bad field rejects the WHOLE request: the good note is not partly saved.
    ('{"category": "  ", "notes": "keep me"}', False),
    ('{"notes": "keep me", "tags": [1]}', False),
])
def test_an_invalid_patch_body_is_400_and_writes_nothing(handler, body, is_b64):
    if callable(body):
        body = body(handler)
    repo = FakeRepo(keys={"pk": "p", "sk": "s"})

    resp = handler.patch_transaction(_patch_event(body=body, is_b64=is_b64), repo)

    assert resp["statusCode"] == 400
    assert repo.update_calls == []


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
        _patch_event(body='{"category": "food", "notes": "n", "tags": ["a"], "budget_excluded": true}'), repo)
    assert resp["statusCode"] == 200
    body = json.loads(resp["body"])
    assert body["category"] == "food" and body["budget_excluded"] is True
    assert repo.update_calls == [
        ("p", "s", {"category": "food", "notes": "n", "tags": ["a"], "budget_excluded": True})]


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


# --- budget_excluded override PATCH (WHIT-296) -------------------------------


def test_patch_budget_excluded_false_is_allowed_and_satisfies_required(handler):
    # A bare {budget_excluded: false} is a valid patch (clears the override); it must
    # NOT trip the "at least one field required" 400 just because the value is falsy.
    repo = FakeRepo(keys={"pk": "p", "sk": "s"})
    resp = handler.patch_transaction(_patch_event(body='{"budget_excluded": false}'), repo)
    assert resp["statusCode"] == 200
    assert repo.update_calls == [("p", "s", {"budget_excluded": False})]


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


_OVERSIZED_BATCH = json.dumps({"updates": [
    {"id": f"t{i}", "category": "coffee"} for i in range(api_constant("TRANSACTION_BATCH_MAX") + 1)]})


@pytest.mark.parametrize("body", [
    '{"note": "x"}',                                        # no updates key
    '{"updates": []}',
    '{"updates": "t1"}',
    _OVERSIZED_BATCH,
    '{"updates": [1, 2]}',
    '{"updates": [{"category": "coffee"}]}',                # item without an id
    '{"updates": [{"id": "t1", "category": "   "}]}',
    "not json",
])
def test_an_invalid_batch_is_400_and_never_reaches_the_database(handler, body):
    repo = FakeBatchRepo()
    resp = handler.patch_transactions_batch(_batch_event(body), repo)
    assert resp["statusCode"] == 400
    assert repo.batch_calls == []


# --- GET /transactions recent feed (get_recent_transactions) -----------------


def test_recent_sorted_newest_first_across_accounts(handler):
    # Interleave dates across accounts so the raw concatenation is NOT already
    # sorted -> only a real descending sort produces the expected order. Guards
    # against the sort being dropped or its reverse flag flipped.
    a, b, c = list(handler.ACCOUNT_ID_MAP.values())[:3]
    repo = _AccountPagesTransactionRepo(pages_by_account={
        a: [([_row(a, "2026-07-04", "a2"), _row(a, "2026-07-01", "a1")], None)],
        b: [([_row(b, "2026-07-02", "b1")], None)],
        c: [([_row(c, "2026-07-03", "c1")], None)],
    })

    result = handler.get_recent_transactions(repo)

    assert [t["date"] for t in result] == [
        "2026-07-04", "2026-07-03", "2026-07-02", "2026-07-01",
    ]


def test_recent_window_is_feed_window_days_on_melbourne_clock(handler, monkeypatch):
    # Freeze today (Melbourne-local, the same clock the budget window uses) and
    # assert the recorded query bounds against LITERAL dates (an independent
    # oracle): start = today - FEED_WINDOW_DAYS(7), end = today (INCLUSIVE, no
    # today+1). Literals catch a reintroduced +1 or a changed window that a
    # recomputed expression would silently mirror.
    monkeypatch.setattr(handler, "melbourne_today", lambda: date(2026, 7, 3))
    a = list(handler.ACCOUNT_ID_MAP.values())[0]
    repo = _AccountPagesTransactionRepo(pages_by_account={a: [([_row(a, "2026-07-01", "t1")], None)]})

    handler.get_recent_transactions(repo)

    assert {c[1] for c in repo.calls} == {"2026-06-26"}  # 2026-07-03 minus 7 days
    assert {c[2] for c in repo.calls} == {"2026-07-03"}  # today, inclusive (no +1 leak)


def test_get_transactions_dispatch_runs_real_body(handler, monkeypatch):
    # The card's core gap: the real get_recent_transactions body runs end-to-end
    # through lambda_handler (NOT monkeypatched away), proving routing plus JSON
    # serialisation of Decimal amounts via json.dumps(default=float).
    a = list(handler.ACCOUNT_ID_MAP.values())[0]
    repo = _AccountPagesTransactionRepo(pages_by_account={
        a: [([_row(a, "2026-07-01", "t1", amount=Decimal("-12.50"), category="coffee")], None)],
    })
    monkeypatch.setattr(handler, "TransactionRepository", lambda: repo)

    event = api_event("GET", "/transactions")
    resp = handler.lambda_handler(event, None)

    assert resp["statusCode"] == 200
    body = json.loads(resp["body"])
    assert len(body) == 1
    assert body[0]["transaction_id"] == "t1"
    assert body[0]["amount"] == -12.5  # Decimal serialised as a JSON number
    assert "pk" not in body[0] and "sk" not in body[0]


def test_recent_returns_pending_and_posted_without_filtering(handler):
    # The feed is a raw window view — it must NOT filter by status. Both a posted
    # and a pending row survive with status intact. Fails if a status filter slips in.
    a = list(handler.ACCOUNT_ID_MAP.values())[0]
    repo = _AccountPagesTransactionRepo(pages_by_account={
        a: [([
            _row(a, "2026-07-02", "posted1", status="posted"),
            _row(a, "2026-07-01", "pending1", status="pending"),
        ], None)],
    })

    by_id = {t["transaction_id"]: t for t in handler.get_recent_transactions(repo)}

    assert by_id["posted1"]["status"] == "posted"
    assert by_id["pending1"]["status"] == "pending"


# --- WHIT-275: tag dedupe happens BEFORE the count cap ------------------------


def test_patch_over_max_raw_tags_that_dedupe_under_the_cap_are_accepted(handler):  # [A9]
    # 20 unique + 10 case-insensitive dups = 30 raw, 20 survive dedupe. The cap is on
    # the CLEANED count, so this is a 200 — proving the count check runs after dedupe.
    unique = [f"t{i}" for i in range(handler.TAG_MAX_COUNT)]
    raw = unique + [t.upper() for t in unique[:10]]
    repo = FakeRepo(keys={"pk": "p", "sk": "s"})
    resp = handler.patch_transaction(_patch_event(body=json.dumps({"tags": raw})), repo)
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"])["tags"] == unique  # first-seen casing kept
