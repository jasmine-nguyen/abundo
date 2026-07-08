"""Tests for the lambda_api handler: PATCH /transactions/{id} and the
GET /transactions recent feed (get_recent_transactions).

The handler is provided by the `handler` fixture (see conftest.py), which imports
lambda_api/handler.py in isolation. patch_transaction_category and
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


class FakeRepo:
    """Stand-in for TransactionRepository that records the write it's asked to do."""

    def __init__(self, keys=None, update_result=True):
        self._keys = keys
        self._update_result = update_result
        self.update_calls = []

    def get_transaction_keys_by_id(self, transaction_id):
        return self._keys

    def update_transaction_category(self, pk, sk, category):
        self.update_calls.append((pk, sk, category))
        return self._update_result


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


def _patch_event(transaction_id="txn-1", body='{"category": "groceries"}', is_b64=False):
    return {
        "rawPath": f"/transactions/{transaction_id}",
        "requestContext": {"http": {"method": "PATCH"}},
        "pathParameters": {"id": transaction_id},
        "body": body,
        "isBase64Encoded": is_b64,
    }


# --- happy path (repo injected directly, no patching) ------------------------


def test_patch_success_persists_category(handler):
    repo = FakeRepo(keys={"pk": "ACCOUNT#up-spending", "sk": "TXN#txn-1"})

    resp = handler.patch_transaction_category(_patch_event(), repo)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"transaction_id": "txn-1", "category": "groceries"}
    # persisted against the keys the resolver returned, with the given category.
    assert repo.update_calls == [("ACCOUNT#up-spending", "TXN#txn-1", "groceries")]


def test_patch_decodes_base64_body(handler):
    repo = FakeRepo(keys={"pk": "p", "sk": "s"})
    encoded = base64.b64encode(b'{"category": "coffee"}').decode()

    resp = handler.patch_transaction_category(_patch_event(body=encoded, is_b64=True), repo)

    assert resp["statusCode"] == 200
    assert repo.update_calls == [("p", "s", "coffee")]


# --- 404s --------------------------------------------------------------------


def test_patch_unknown_id_returns_404_without_writing(handler):
    repo = FakeRepo(keys=None)

    resp = handler.patch_transaction_category(_patch_event(), repo)

    assert resp["statusCode"] == 404
    assert repo.update_calls == []  # never attempt the write if the id doesn't resolve


def test_patch_row_vanished_returns_404(handler):
    # get_transaction_keys_by_id found keys, but the conditional write failed
    # (row deleted in between) -> update returns False -> 404, not 500.
    repo = FakeRepo(keys={"pk": "p", "sk": "s"}, update_result=False)

    resp = handler.patch_transaction_category(_patch_event(), repo)

    assert resp["statusCode"] == 404


def test_patch_missing_path_id_returns_404(handler):
    event = _patch_event()
    event["pathParameters"] = {}  # no id

    resp = handler.patch_transaction_category(event, FakeRepo(keys={"pk": "p", "sk": "s"}))

    assert resp["statusCode"] == 404


# --- 400s --------------------------------------------------------------------


def test_patch_invalid_json_returns_400(handler):
    resp = handler.patch_transaction_category(_patch_event(body="not json"),
                                              FakeRepo(keys={"pk": "p", "sk": "s"}))
    assert resp["statusCode"] == 400


def test_patch_base64_non_utf8_body_returns_400(handler):
    # Valid base64, but the decoded bytes aren't UTF-8 — must be a clean 400, not a 500.
    encoded = base64.b64encode(b"\xff\xfe\xff").decode()

    resp = handler.patch_transaction_category(_patch_event(body=encoded, is_b64=True),
                                              FakeRepo(keys={"pk": "p", "sk": "s"}))
    assert resp["statusCode"] == 400


def test_patch_non_dict_body_returns_400(handler):
    resp = handler.patch_transaction_category(_patch_event(body="[1, 2, 3]"),
                                              FakeRepo(keys={"pk": "p", "sk": "s"}))
    assert resp["statusCode"] == 400


def test_patch_missing_category_returns_400(handler):
    resp = handler.patch_transaction_category(_patch_event(body='{"note": "x"}'),
                                              FakeRepo(keys={"pk": "p", "sk": "s"}))
    assert resp["statusCode"] == 400


def test_patch_blank_category_returns_400(handler):
    resp = handler.patch_transaction_category(_patch_event(body='{"category": "   "}'),
                                              FakeRepo(keys={"pk": "p", "sk": "s"}))
    assert resp["statusCode"] == 400


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
    monkeypatch.setattr(handler, "patch_transaction_category",
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
    assert repo.update_calls == [("p", "s", "groceries")]


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


# --- GET /transactions/range date-range query (get_transactions_by_range, WHIT-34) ---


def _range_event(params):
    return {
        "rawPath": "/transactions/range",
        "requestContext": {"http": {"method": "GET"}},
        "queryStringParameters": params,
    }


def test_range_happy_path_strips_keys_and_shapes_response(handler):
    repo = FakeRecentFeedRepo(
        {"up-spending": [([_row("up-spending", "2026-06-15", "t1", amount=Decimal("-12.50"))], None)]}
    )
    resp = handler.get_transactions_by_range(
        _range_event({"account_id": "up-spending", "from": "2026-06-01", "to": "2026-06-30"}), repo
    )

    assert resp["statusCode"] == 200
    # repo called with the ONE account, normalised STRING dates, default limit, no cursor.
    assert repo.calls == [("up-spending", "2026-06-01", "2026-06-30", handler.MAX_PAGE_SIZE, None)]
    body = json.loads(resp["body"])
    txn = body["transactions"][0]
    assert "pk" not in txn and "sk" not in txn          # DynamoDB keys stripped
    assert txn["transaction_id"] == "t1"
    assert txn["category"] is None                       # sparse field defaulted
    assert txn["amount"] == -12.5                        # Decimal serialised (no 500)
    assert body["nextCursor"] is None                    # last page → null cursor


def test_range_from_only_passes_none_end_date(handler):
    # `to` omitted → end_date is None (repo uses gte start), not a 400.
    repo = FakeRecentFeedRepo({"up-spending": [([], None)]})
    resp = handler.get_transactions_by_range(
        _range_event({"account_id": "up-spending", "from": "2026-06-01"}), repo
    )
    assert resp["statusCode"] == 200
    assert repo.calls[0][:3] == ("up-spending", "2026-06-01", None)


def test_range_normalises_basic_format_dates(handler):
    # date.fromisoformat accepts basic format on py3.11+/3.12 runtime; we re-emit .isoformat()
    # so the value the repo queries lexically matches the stored YYYY-MM-DD dates.
    repo = FakeRecentFeedRepo({"up-spending": [([], None)]})
    handler.get_transactions_by_range(
        _range_event({"account_id": "up-spending", "from": "20260601", "to": "20260630"}), repo
    )
    assert repo.calls[0][1:3] == ("2026-06-01", "2026-06-30")


def test_range_cursor_round_trips(handler):
    # Page 1 returns a DynamoDB LastEvaluatedKey → nextCursor is an opaque string. Echoing
    # it back on page 2 decodes to the ORIGINAL key dict and is passed to the repo as cursor.
    key = {"account_id": "up-spending", "date": "2026-07-01", "pk": "ACCOUNT#up-spending", "sk": "TXN#t1"}
    repo = FakeRecentFeedRepo({"up-spending": [
        ([_row("up-spending", "2026-07-01", "t1")], key),   # page 1 → a cursor
        ([_row("up-spending", "2026-06-30", "t2")], None),  # page 2 → last
    ]})

    resp1 = handler.get_transactions_by_range(
        _range_event({"account_id": "up-spending", "from": "2026-06-01", "to": "2026-07-01"}), repo
    )
    body1 = json.loads(resp1["body"])
    next_cursor = body1["nextCursor"]
    assert isinstance(next_cursor, str) and next_cursor
    assert handler._decode_cursor(next_cursor) == key      # opaque token → the raw key

    resp2 = handler.get_transactions_by_range(
        _range_event({"account_id": "up-spending", "from": "2026-06-01", "to": "2026-07-01", "cursor": next_cursor}), repo
    )
    body2 = json.loads(resp2["body"])
    assert body2["nextCursor"] is None
    assert repo.calls[1][4] == key                         # decoded key handed to the repo


def test_range_limit_above_max_is_clamped(handler):
    repo = FakeRecentFeedRepo({"up-spending": [([], None)]})
    handler.get_transactions_by_range(
        _range_event({"account_id": "up-spending", "from": "2026-06-01", "limit": "500"}), repo
    )
    assert repo.calls[0][3] == handler.MAX_PAGE_SIZE


def test_range_limit_zero_is_clamped_to_one(handler):
    # A 0/negative Limit is a DynamoDB ValidationException; the handler clamps to >=1.
    repo = FakeRecentFeedRepo({"up-spending": [([], None)]})
    handler.get_transactions_by_range(
        _range_event({"account_id": "up-spending", "from": "2026-06-01", "limit": "0"}), repo
    )
    assert repo.calls[0][3] == 1


def test_range_unknown_account_returns_empty_page(handler):
    # An unknown but non-empty account_id isn't an error — the repo just yields nothing.
    repo = FakeRecentFeedRepo({"up-spending": [([_row("up-spending", "2026-06-01", "t1")], None)]})
    resp = handler.get_transactions_by_range(
        _range_event({"account_id": "who-dis", "from": "2026-06-01"}), repo
    )
    assert resp["statusCode"] == 200
    body = json.loads(resp["body"])
    assert body == {"transactions": [], "nextCursor": None}


def test_range_missing_query_params_is_400_not_500(handler):
    # API Gateway sends queryStringParameters: None when the query string is absent.
    repo = FakeRecentFeedRepo({"up-spending": [([], None)]})
    event = {"rawPath": "/transactions/range", "requestContext": {"http": {"method": "GET"}}, "queryStringParameters": None}
    resp = handler.get_transactions_by_range(event, repo)
    assert resp["statusCode"] == 400          # account_id required
    assert repo.calls == []


@pytest.mark.parametrize("params", [
    {"from": "2026-06-01"},                                   # missing account_id
    {"account_id": "up-spending"},                           # missing from
    {"account_id": "up-spending", "from": ""},               # empty from
    {"account_id": "up-spending", "from": "not-a-date"},     # non-ISO from
    {"account_id": "up-spending", "from": "2026-06-01", "to": "nope"},  # non-ISO to
    {"account_id": "up-spending", "to": "2026-06-30"},       # end-only (no from) — repo can't express it
    {"account_id": "up-spending", "from": "2026-06-01", "limit": "abc"},  # non-numeric limit
])
def test_range_validation_400s_and_never_hits_repo(handler, params):
    repo = FakeRecentFeedRepo({"up-spending": [([_row("up-spending", "2026-06-01", "t1")], None)]})
    resp = handler.get_transactions_by_range(_range_event(params), repo)
    assert resp["statusCode"] == 400
    assert repo.calls == []          # rejected before the query


def test_range_malformed_cursor_is_400(handler):
    # A valid-base64 token that isn't JSON → _BadCursor → 400 (a forged cursor never 500s).
    repo = FakeRecentFeedRepo({"up-spending": [([], None)]})
    bad_cursor = base64.urlsafe_b64encode(b"not json").decode("ascii")
    resp = handler.get_transactions_by_range(
        _range_event({"account_id": "up-spending", "from": "2026-06-01", "cursor": bad_cursor}), repo
    )
    assert resp["statusCode"] == 400
    assert repo.calls == []


def test_range_dispatches_through_lambda_handler(handler, monkeypatch):
    # Proves lambda_handler routes GET /transactions/range to the range handler (single
    # account, date-range call), NOT the merged feed, and returns the {transactions,nextCursor} shape.
    repo = FakeRecentFeedRepo({"up-spending": [([_row("up-spending", "2026-06-01", "t1")], None)]})
    monkeypatch.setattr(handler, "TransactionRepository", lambda: repo)
    monkeypatch.setattr(handler, "get_recent_transactions",
                        lambda repo: pytest.fail("range route reached the feed handler"))

    resp = handler.lambda_handler(
        _range_event({"account_id": "up-spending", "from": "2026-06-01"}), None
    )

    assert resp["statusCode"] == 200
    body = json.loads(resp["body"])
    assert [t["transaction_id"] for t in body["transactions"]] == ["t1"]
    assert body["nextCursor"] is None
    assert repo.calls[0][0] == "up-spending"


def test_cursor_encode_decode_none_round_trip(handler):
    # No next page → encode(None) is None (literal null nextCursor); decode(None)/("") → None.
    assert handler._encode_cursor(None) is None
    assert handler._decode_cursor(None) is None
    assert handler._decode_cursor("") is None


# --- GET /transactions/range: adversarial gap tests (WHIT-34, qa + review) ----
# Gaps the implementer's suite left open: explicit-empty `to`, single-day and REVERSED
# ranges, a wrong-shape cursor, float/negative/whitespace `limit`, a date with a time
# component, category setdefault-vs-overwrite, page-order preservation, and the
# cursor-forwarded-verbatim contract. Each asserts against the real handler, so a revert
# of the relevant branch flips it red.


def test_range_empty_to_is_treated_as_open_ended(handler):
    # `?...&to=` (present but EMPTY) is falsy, so raw_to is "" → end_date None (open-ended),
    # NOT date.fromisoformat("") → 400. Guards the `if raw_to:` truthiness check.
    repo = FakeRecentFeedRepo({"up-spending": [([], None)]})
    resp = handler.get_transactions_by_range(
        _range_event({"account_id": "up-spending", "from": "2026-06-01", "to": ""}), repo
    )
    assert resp["statusCode"] == 200
    assert repo.calls[0][:3] == ("up-spending", "2026-06-01", None)


def test_range_single_day_range_forwards_equal_bounds(handler):
    # from == to is a valid single-day query (between(x, x) is inclusive): 200, both bounds
    # forwarded equal. The reversed-range guard uses `<`, so equal bounds must NOT 400.
    repo = FakeRecentFeedRepo({"up-spending": [([], None)]})
    resp = handler.get_transactions_by_range(
        _range_event({"account_id": "up-spending", "from": "2026-06-15", "to": "2026-06-15"}), repo
    )
    assert resp["statusCode"] == 200
    assert repo.calls[0][1:3] == ("2026-06-15", "2026-06-15")


def test_range_reversed_range_is_400(handler):
    # WHIT-34 (code-critic): `from` > `to` is rejected at the boundary as a 400 — the repo's
    # Key.between(lo>hi) would otherwise hit DynamoDB with lower>upper (ValidationException →
    # 500). Reject before the query; the repo is never called.
    repo = FakeRecentFeedRepo({"up-spending": [([_row("up-spending", "2026-06-15", "t1")], None)]})
    resp = handler.get_transactions_by_range(
        _range_event({"account_id": "up-spending", "from": "2026-06-30", "to": "2026-06-01"}), repo
    )
    assert resp["statusCode"] == 400
    assert repo.calls == []


def test_range_wrong_shape_cursor_is_400(handler):
    # WHIT-34 (code-critic): a well-formed base64 of a JSON OBJECT with the wrong keys
    # ({"foo":"bar"}) is not a valid date-index page token. Reject it as a 400 rather than
    # forward it to DynamoDB as a bad ExclusiveStartKey (ValidationException → 500).
    repo = FakeRecentFeedRepo({"up-spending": [([], None)]})
    bad = base64.urlsafe_b64encode(b'{"foo": "bar"}').decode("ascii")
    resp = handler.get_transactions_by_range(
        _range_event({"account_id": "up-spending", "from": "2026-06-01", "cursor": bad}), repo
    )
    assert resp["statusCode"] == 400
    assert repo.calls == []


def test_range_float_limit_is_400(handler):
    # int("1.5") raises ValueError → 400. A DIFFERENT failure class from the covered "abc":
    # a naive float()-based parse would ACCEPT "1.5" and go 200.
    repo = FakeRecentFeedRepo({"up-spending": [([], None)]})
    resp = handler.get_transactions_by_range(
        _range_event({"account_id": "up-spending", "from": "2026-06-01", "limit": "1.5"}), repo
    )
    assert resp["statusCode"] == 400
    assert repo.calls == []


def test_range_negative_limit_clamped_to_one(handler):
    # int("-5") = -5 → max(1, min(-5, MAX)) = 1. Companion to the covered limit=0 case:
    # a 0/negative DynamoDB Limit is a ValidationException, so the lower clamp must hold.
    repo = FakeRecentFeedRepo({"up-spending": [([], None)]})
    handler.get_transactions_by_range(
        _range_event({"account_id": "up-spending", "from": "2026-06-01", "limit": "-5"}), repo
    )
    assert repo.calls[0][3] == 1


def test_range_whitespace_limit_is_accepted(handler):
    # Python int(" 5 ") strips surrounding whitespace → 5 (not a 400). Documents the lenient
    # parse; every value is clamped to [1, MAX] so a valid query results regardless.
    repo = FakeRecentFeedRepo({"up-spending": [([], None)]})
    resp = handler.get_transactions_by_range(
        _range_event({"account_id": "up-spending", "from": "2026-06-01", "limit": " 5 "}), repo
    )
    assert resp["statusCode"] == 200
    assert repo.calls[0][3] == 5


def test_range_date_with_time_component_is_400(handler):
    # A date carrying a time part ("2026-06-01T00:00") — date.fromisoformat rejects it (it
    # parses a date, not a datetime) → 400. Guards that a bare-date-stored `date` is never
    # queried against a datetime string that wouldn't lexically match.
    repo = FakeRecentFeedRepo({"up-spending": [([], None)]})
    resp = handler.get_transactions_by_range(
        _range_event({"account_id": "up-spending", "from": "2026-06-01T00:00"}), repo
    )
    assert resp["statusCode"] == 400
    assert repo.calls == []


def test_range_preserves_present_category(handler):
    # setdefault, not assignment: a row that already has a category keeps it, while a sibling
    # with none defaults to null. Catches a regression from setdefault to `= None`.
    repo = FakeRecentFeedRepo({"up-spending": [([
        _row("up-spending", "2026-06-02", "has_cat", category="coffee"),
        _row("up-spending", "2026-06-01", "no_cat"),
    ], None)]})
    resp = handler.get_transactions_by_range(
        _range_event({"account_id": "up-spending", "from": "2026-06-01", "to": "2026-06-30"}), repo
    )
    by_id = {t["transaction_id"]: t for t in json.loads(resp["body"])["transactions"]}
    assert by_id["has_cat"]["category"] == "coffee"
    assert by_id["no_cat"]["category"] is None


def test_range_does_not_resort_page(handler):
    # Unlike the merged feed, the range endpoint returns the repo's page order as-is (the repo
    # already sorts newest-first via ScanIndexForward=False). Proves the handler adds NO
    # re-sort of its own: rows come back in the exact order the repo gave.
    repo = FakeRecentFeedRepo({"up-spending": [([
        _row("up-spending", "2026-06-10", "first"),
        _row("up-spending", "2026-06-20", "second"),   # deliberately NOT date-descending
        _row("up-spending", "2026-06-05", "third"),
    ], None)]})
    resp = handler.get_transactions_by_range(
        _range_event({"account_id": "up-spending", "from": "2026-06-01", "to": "2026-06-30"}), repo
    )
    order = [t["transaction_id"] for t in json.loads(resp["body"])["transactions"]]
    assert order == ["first", "second", "third"]


def test_range_cross_account_cursor_is_400(handler):
    # WHIT-34: a cursor is bound to the account it was minted for. A valid-SHAPE cursor for
    # account A, resent with account_id=B, contradicts the query's partition — DynamoDB would
    # reject the ExclusiveStartKey (ValidationException → 500). The handler rejects it as a 400
    # before the query, so a cross-account cursor never reaches the repo.
    foreign_key = {"account_id": "account-A", "date": "2026-07-01",
                   "pk": "ACCOUNT#account-A", "sk": "TXN#t1"}
    cursor = handler._encode_cursor(foreign_key)
    repo = FakeRecentFeedRepo({"account-B": [([], None)]})
    resp = handler.get_transactions_by_range(
        _range_event({"account_id": "account-B", "from": "2026-06-01", "cursor": cursor}), repo
    )
    assert resp["statusCode"] == 400
    assert repo.calls == []


def test_range_matching_account_cursor_is_forwarded(handler):
    # The companion to the cross-account 400: a cursor whose account_id MATCHES the query's
    # account_id passes the guard and is handed to the repo verbatim (normal pagination).
    key = {"account_id": "up-spending", "date": "2026-07-01",
           "pk": "ACCOUNT#up-spending", "sk": "TXN#t1"}
    cursor = handler._encode_cursor(key)
    repo = FakeRecentFeedRepo({"up-spending": [([], None)]})
    resp = handler.get_transactions_by_range(
        _range_event({"account_id": "up-spending", "from": "2026-06-01", "cursor": cursor}), repo
    )
    assert resp["statusCode"] == 200
    assert repo.calls[0][4] == key      # matching-account cursor forwarded


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
