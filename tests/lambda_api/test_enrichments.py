"""WHIT-52 Slice 1 — the BankSync enrichments proxy.

Two layers:
  - the client + Rule adapter in banksync_enrichments (via the `enrichments`
    fixture): payload shape, header injection, list mapping/skip, idempotent
    delete, error wrapping, key caching.
  - the handler routes (via the `handler` fixture): validation 400s, the
    upstream-error -> 400/502 mapping, and the happy paths.

No network, no AWS: urllib.request.urlopen is monkeypatched and `ssm` is faked by
conftest.py.
"""

import json

import pytest


# --- helpers -----------------------------------------------------------------


class _FakeResponse:
    """Stand-in for urlopen()'s return: a context manager with .read() -> bytes."""

    def __init__(self, payload):
        self._body = json.dumps(payload).encode() if payload is not None else b""

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self._body


def _http_error(be, code):
    import io
    import urllib.error

    return urllib.error.HTTPError(
        url="https://api.banksync.io/v1/enrichments",
        code=code, msg="boom", hdrs=None, fp=io.BytesIO(b""),
    )


def _event(method, path, body=None, path_params=None):
    event = {"rawPath": path, "requestContext": {"http": {"method": method}}}
    if body is not None:
        event["body"] = json.dumps(body)
    if path_params is not None:
        event["pathParameters"] = path_params
    return event


def _enrichment(**over):
    """A well-formed BankSync `rule` enrichment (WOOLWORTHS -> groceries)."""
    enr = {
        "id": "enr_1",
        "type": "rule",
        "dataType": "transactions",
        "ruleConfig": {"rules": [{
            "conditions": {"logic": "and", "conditions": [
                {"field": "description", "operator": "contains", "value": "WOOLWORTHS"}
            ]},
            "action": {"field": "category", "value": "groceries"},
        }]},
    }
    enr.update(over)
    return enr


# --- client + adapter (banksync_enrichments) ---------------------------------


def test_create_rule_builds_correct_payload_and_headers(enrichments, monkeypatch):
    # WHIT-497: create_rule now lists existing rules first (dedup). With no match
    # (empty list) it POSTs exactly as before — this asserts that POST is unchanged.
    captured = {}

    def fake_urlopen(req, timeout=None):
        if req.method == "GET":
            return _FakeResponse({"success": True, "data": []})  # no existing rule → fall through to POST
        captured["req"] = req
        return _FakeResponse({"success": True, "data": {"id": "enr_new"}})

    monkeypatch.setattr(enrichments.urllib.request, "urlopen", fake_urlopen)

    rule = enrichments.create_rule("description", "contains", "WOOLWORTHS", "groceries")

    req = captured["req"]
    assert req.method == "POST"
    assert req.full_url == "https://api.banksync.io/v1/enrichments"
    # urllib title-cases header keys: "X-API-Key" -> "X-api-key".
    assert req.get_header("X-api-key") == "test-api-key"
    assert req.get_header("User-agent") == "abundo-app-api"

    sent = json.loads(req.data)
    assert sent["type"] == "rule"
    assert sent["dataType"] == "transactions"
    assert sent["allFeeds"] is True
    leaf = sent["ruleConfig"]["rules"][0]["conditions"]["conditions"][0]
    assert leaf == {"field": "description", "operator": "contains", "value": "WOOLWORTHS"}
    assert sent["ruleConfig"]["rules"][0]["action"] == {"field": "category", "value": "groceries"}

    # Returned Rule uses BankSync's id + our inputs (no dependence on the echo).
    assert rule == {
        "id": "enr_new", "field": "description", "operator": "contains",
        "value": "WOOLWORTHS", "categoryId": "groceries",
    }


# --- WHIT-497: create_rule is idempotent on rule identity --------------------


def test_create_rule_returns_existing_on_identity_match(enrichments, monkeypatch):
    # A rule with the same (field, operator, folded value, category) already exists,
    # so create_rule returns it and NEVER POSTs a duplicate. The requested value
    # differs by case + surrounding whitespace ("  woolworths " vs stored
    # "WOOLWORTHS") — the fold must still call it a match.
    def fake_urlopen(req, timeout=None):
        if req.method == "GET":
            return _FakeResponse({"success": True, "data": [_enrichment()]})  # WOOLWORTHS -> groceries
        raise AssertionError("create_rule must not POST when a duplicate already exists")

    monkeypatch.setattr(enrichments.urllib.request, "urlopen", fake_urlopen)

    rule = enrichments.create_rule("description", "contains", "  woolworths ", "groceries")

    # Returns the EXISTING rule (its stored id + original casing), not a new one.
    assert rule == {
        "id": "enr_1", "field": "description", "operator": "contains",
        "value": "WOOLWORTHS", "categoryId": "groceries",
    }


def test_create_rule_folds_internal_whitespace(enrichments, monkeypatch):
    # The fold collapses internal whitespace runs, mirroring the client's
    # normaliseRuleIdentity: stored "KKV  INTL" (two spaces) matches a create of
    # "KKV INTL" (one space) → no duplicate POSTed.
    stored = _enrichment(id="enr_kkv", ruleConfig={"rules": [{
        "conditions": {"logic": "and", "conditions": [
            {"field": "description", "operator": "contains", "value": "KKV  INTL"}]},
        "action": {"field": "category", "value": "groceries"},
    }]})

    def fake_urlopen(req, timeout=None):
        if req.method == "GET":
            return _FakeResponse({"success": True, "data": [stored]})
        raise AssertionError("whitespace-only variant must dedup, not POST")

    monkeypatch.setattr(enrichments.urllib.request, "urlopen", fake_urlopen)

    rule = enrichments.create_rule("description", "contains", "KKV INTL", "groceries")
    assert rule["id"] == "enr_kkv"


def test_create_rule_fails_open_when_lookup_errors(enrichments, monkeypatch):
    # Fail OPEN: a failed lookup GET must NOT block the create. We swallow the
    # BankSyncError and POST as before — worst case is the one duplicate we already
    # tolerate today; a failed READ never blocks the WRITE.
    def fake_urlopen(req, timeout=None):
        if req.method == "GET":
            raise _http_error(enrichments, 500)
        return _FakeResponse({"success": True, "data": {"id": "enr_new"}})

    monkeypatch.setattr(enrichments.urllib.request, "urlopen", fake_urlopen)

    rule = enrichments.create_rule("description", "contains", "WOOLWORTHS", "groceries")
    assert rule["id"] == "enr_new"  # created despite the failed lookup


def test_create_rule_distinct_category_still_creates(enrichments, monkeypatch):
    # Same value + field + operator but a DIFFERENT category is a different rule →
    # create still POSTs (category_id is exact in the identity).
    posted = {}

    def fake_urlopen(req, timeout=None):
        if req.method == "GET":
            return _FakeResponse({"success": True, "data": [_enrichment()]})  # ... -> groceries
        posted["called"] = True
        return _FakeResponse({"success": True, "data": {"id": "enr_new"}})

    monkeypatch.setattr(enrichments.urllib.request, "urlopen", fake_urlopen)

    rule = enrichments.create_rule("description", "contains", "WOOLWORTHS", "dining")
    assert posted.get("called") is True
    assert rule["id"] == "enr_new"


def test_create_rule_distinct_field_operator_still_creates(enrichments, monkeypatch):
    # Stored: `description contains WOOLWORTHS -> groceries`. Creating
    # `category equals woolworths -> groceries` has the same folded value + category
    # but a different field/operator (targets different data), so it is NOT a
    # duplicate — field/operator stay exact in the identity, so it still POSTs.
    posted = {}

    def fake_urlopen(req, timeout=None):
        if req.method == "GET":
            return _FakeResponse({"success": True, "data": [_enrichment()]})
        posted["called"] = True
        return _FakeResponse({"success": True, "data": {"id": "enr_new"}})

    monkeypatch.setattr(enrichments.urllib.request, "urlopen", fake_urlopen)

    rule = enrichments.create_rule("category", "equals", "woolworths", "groceries")
    assert posted.get("called") is True
    assert rule["id"] == "enr_new"


# --- WHIT-497 QA gap tests (adversarial edges the create_rule dedup tests miss) --


def test_create_rule_post_failure_still_raises(enrichments, monkeypatch):
    # [A4]. NOT duplicated by test_create_rule_fails_open_when_lookup_errors: that fails
    # the GET and asserts the POST succeeds. This is the OPPOSITE side — the lookup
    # succeeds (empty, no match) and the POST itself 500s. The try/except wraps only
    # list_rules(), so the POST BankSyncError must propagate, as pre-WHIT-497.
    def fake_urlopen(req, timeout=None):
        if req.method == "GET":
            return _FakeResponse({"success": True, "data": []})
        raise _http_error(enrichments, 500)

    monkeypatch.setattr(enrichments.urllib.request, "urlopen", fake_urlopen)

    with pytest.raises(enrichments.BankSyncError) as ei:
        enrichments.create_rule("description", "contains", "WOOLWORTHS", "groceries")
    assert ei.value.upstream_status == 500


def test_create_rule_substring_value_does_not_dedup(enrichments, monkeypatch):
    # [A5]. NOT duplicated by the fold tests (case/whitespace variants of the SAME
    # token). Here created "WOOL" is a substring of stored "WOOLWORTHS": the identity is
    # exact string equality after fold, not containment → must POST a new rule.
    posted = {}

    def fake_urlopen(req, timeout=None):
        if req.method == "GET":
            return _FakeResponse({"success": True, "data": [_enrichment()]})  # WOOLWORTHS
        posted["called"] = True
        return _FakeResponse({"success": True, "data": {"id": "enr_new"}})

    monkeypatch.setattr(enrichments.urllib.request, "urlopen", fake_urlopen)

    rule = enrichments.create_rule("description", "contains", "WOOL", "groceries")
    assert posted.get("called") is True
    assert rule["id"] == "enr_new"


def test_create_rule_superstring_value_does_not_dedup(enrichments, monkeypatch):
    # [A6]. Mirror of the substring case: created value is a SUPERSTRING of the stored
    # one ("WOOLWORTHS METRO" vs "WOOLWORTHS"). Distinct rule → POSTs.
    posted = {}

    def fake_urlopen(req, timeout=None):
        if req.method == "GET":
            return _FakeResponse({"success": True, "data": [_enrichment()]})
        posted["called"] = True
        return _FakeResponse({"success": True, "data": {"id": "enr_new"}})

    monkeypatch.setattr(enrichments.urllib.request, "urlopen", fake_urlopen)

    rule = enrichments.create_rule("description", "contains", "WOOLWORTHS METRO", "groceries")
    assert posted.get("called") is True
    assert rule["id"] == "enr_new"


def test_create_rule_matches_rule_not_first_in_list(enrichments, monkeypatch):
    # [A7]. NOT duplicated: every implementer dedup test uses a single-element list, so a
    # bug that only checked data[0] would pass their suite. Here the match is the THIRD
    # rule; the first two differ by value/category. Must still dedup.
    others = [
        _enrichment(id="enr_a", ruleConfig={"rules": [{
            "conditions": {"logic": "and", "conditions": [
                {"field": "description", "operator": "contains", "value": "COLES"}]},
            "action": {"field": "category", "value": "groceries"},
        }]}),
        _enrichment(id="enr_b", ruleConfig={"rules": [{
            "conditions": {"logic": "and", "conditions": [
                {"field": "description", "operator": "contains", "value": "WOOLWORTHS"}]},
            "action": {"field": "category", "value": "dining"},  # same value, diff category
        }]}),
        _enrichment(id="enr_target"),  # description contains WOOLWORTHS -> groceries
    ]

    def fake_urlopen(req, timeout=None):
        if req.method == "GET":
            return _FakeResponse({"success": True, "data": others})
        raise AssertionError("a match exists later in the list — must not POST")

    monkeypatch.setattr(enrichments.urllib.request, "urlopen", fake_urlopen)

    rule = enrichments.create_rule("description", "contains", "woolworths", "groceries")
    assert rule["id"] == "enr_target"


def test_create_enrichment_dedup_hit_returns_valid_201(handler, monkeypatch):
    # [A9]. The handler tests all monkeypatch create_rule, so the REAL idempotent-hit
    # return shape is never exercised through handler.create_enrichment. Here we let the
    # real create_rule run and fake only the network: the GET returns an existing
    # WOOLWORTHS->groceries rule, so create_rule returns it WITHOUT POSTing. The handler
    # must still emit a well-formed 201 whose body is the existing Rule.
    import banksync_enrichments as be  # same module object handler's create_rule closes over

    def fake_urlopen(req, timeout=None):
        if req.method == "GET":
            return _FakeResponse({"success": True, "data": [_enrichment()]})
        raise AssertionError("dedup hit must not POST via the handler path")

    monkeypatch.setattr(be.urllib.request, "urlopen", fake_urlopen)

    resp = handler.lambda_handler(
        _event("POST", "/enrichments", {"value": " woolworths ", "categoryId": "groceries"}),
        None)

    assert resp["statusCode"] == 201
    body = json.loads(resp["body"])
    assert body == {
        "id": "enr_1", "field": "description", "operator": "contains",
        "value": "WOOLWORTHS", "categoryId": "groceries",
    }


def test_list_rules_maps_and_skips_non_conforming(enrichments, monkeypatch):
    payload = {"success": True, "data": [
        _enrichment(),                                   # maps
        _enrichment(id="enr_2", type="alert"),           # skipped: not a rule
        _enrichment(id="enr_3", ruleConfig={"rules": [{  # skipped: action not category
            "conditions": {"logic": "and", "conditions": [
                {"field": "description", "operator": "contains", "value": "X"}]},
            "action": {"field": "notes", "value": "y"},
        }]}),
        _enrichment(id="enr_4", ruleConfig={"rules": [{  # skipped: nested group, no leaf field
            "conditions": {"logic": "and", "conditions": [
                {"logic": "or", "conditions": []}]},
            "action": {"field": "category", "value": "z"},
        }]}),
    ]}
    monkeypatch.setattr(
        enrichments.urllib.request, "urlopen",
        lambda req, timeout=None: _FakeResponse(payload))

    rules = enrichments.list_rules()

    assert rules == [{
        "id": "enr_1", "field": "description", "operator": "contains",
        "value": "WOOLWORTHS", "categoryId": "groceries",
    }]


def test_list_rules_empty_data(enrichments, monkeypatch):
    monkeypatch.setattr(
        enrichments.urllib.request, "urlopen",
        lambda req, timeout=None: _FakeResponse({"success": True, "data": []}))
    assert enrichments.list_rules() == []


def test_delete_rule_404_is_idempotent(enrichments, monkeypatch):
    def fake_urlopen(req, timeout=None):
        raise _http_error(enrichments, 404)

    monkeypatch.setattr(enrichments.urllib.request, "urlopen", fake_urlopen)
    # An already-gone rule must not raise.
    assert enrichments.delete_rule("gone") is None


def test_delete_rule_other_error_raises(enrichments, monkeypatch):
    def fake_urlopen(req, timeout=None):
        raise _http_error(enrichments, 500)

    monkeypatch.setattr(enrichments.urllib.request, "urlopen", fake_urlopen)
    with pytest.raises(enrichments.BankSyncError) as excinfo:
        enrichments.delete_rule("enr_1")
    assert excinfo.value.upstream_status == 500


def test_request_http_error_carries_status(enrichments, monkeypatch):
    monkeypatch.setattr(
        enrichments.urllib.request, "urlopen",
        lambda req, timeout=None: (_ for _ in ()).throw(_http_error(enrichments, 422)))
    with pytest.raises(enrichments.BankSyncError) as excinfo:
        enrichments.list_rules()
    assert excinfo.value.upstream_status == 422


def test_request_url_error_is_none_status(enrichments, monkeypatch):
    import urllib.error

    def fake_urlopen(req, timeout=None):
        raise urllib.error.URLError("unreachable")

    monkeypatch.setattr(enrichments.urllib.request, "urlopen", fake_urlopen)
    with pytest.raises(enrichments.BankSyncError) as excinfo:
        enrichments.list_rules()
    assert excinfo.value.upstream_status is None


def test_get_api_key_reads_the_banksync_path(enrichments, monkeypatch):
    # The wrapper must pass the BankSync key path to the shared fetch (WHIT-454).
    # Caching itself is covered in tests/shared/test_api_key.py.
    import api_key
    calls = []
    monkeypatch.setattr(api_key, "get_param", lambda path: calls.append(path) or "k")

    assert enrichments.get_api_key() == "k"
    assert calls == [enrichments.BANKSYNC_API_KEY_PATH]


# --- handler routes ----------------------------------------------------------


def test_get_enrichments_returns_rules(handler, monkeypatch):
    rule = {"id": "enr_1", "field": "description", "operator": "contains",
            "value": "WOOLWORTHS", "categoryId": "groceries"}
    monkeypatch.setattr(handler, "list_rules", lambda: [rule])

    resp = handler.lambda_handler(_event("GET", "/enrichments"), None)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == [rule]


def test_get_enrichments_upstream_error_is_502(handler, monkeypatch):
    def boom():
        raise handler.BankSyncError(500)

    monkeypatch.setattr(handler, "list_rules", boom)
    resp = handler.lambda_handler(_event("GET", "/enrichments"), None)
    assert resp["statusCode"] == 502


def test_create_enrichment_happy_path_applies_defaults(handler, monkeypatch):
    captured = {}

    def fake_create(field, operator, value, category_id):
        captured.update(field=field, operator=operator, value=value, category_id=category_id)
        return {"id": "enr_new", "field": field, "operator": operator,
                "value": value, "categoryId": category_id}

    monkeypatch.setattr(handler, "create_rule", fake_create)

    resp = handler.lambda_handler(
        _event("POST", "/enrichments", {"value": " WOOLWORTHS ", "categoryId": " groceries "}),
        None)

    assert resp["statusCode"] == 201
    # Defaults applied, and value/categoryId trimmed.
    assert captured == {"field": "description", "operator": "contains",
                        "value": "WOOLWORTHS", "category_id": "groceries"}


def test_create_enrichment_accepts_verified_operator(handler, monkeypatch):
    captured = {}
    monkeypatch.setattr(handler, "create_rule",
                        lambda f, o, v, c: captured.update(f=f, o=o) or {"id": "e"})

    resp = handler.lambda_handler(
        _event("POST", "/enrichments",
               {"value": "FOOD_AND_DRINK", "categoryId": "eating-out",
                "field": "category", "operator": "equals"}),
        None)

    assert resp["statusCode"] == 201
    assert captured == {"f": "category", "o": "equals"}


@pytest.mark.parametrize("body, missing", [
    ({"categoryId": "groceries"}, "value"),
    ({"value": "  ", "categoryId": "groceries"}, "value"),
    ({"value": "X"}, "categoryId"),
    ({"value": "X", "categoryId": "  "}, "categoryId"),
])
def test_create_enrichment_missing_fields_400(handler, body, missing):
    resp = handler.lambda_handler(_event("POST", "/enrichments", body), None)
    assert resp["statusCode"] == 400
    assert missing in json.loads(resp["body"])["error"]


@pytest.mark.parametrize("bad", [
    {"value": "X", "categoryId": "c", "field": "amount"},
    {"value": "X", "categoryId": "c", "operator": "startsWith"},
])
def test_create_enrichment_rejects_unverified_vocab_400(handler, bad):
    # An unverified field/operator is rejected before it can reach BankSync.
    resp = handler.lambda_handler(_event("POST", "/enrichments", bad), None)
    assert resp["statusCode"] == 400


def test_create_enrichment_bad_rule_upstream_is_400(handler, monkeypatch):
    def boom(*a):
        raise handler.BankSyncError(422)

    monkeypatch.setattr(handler, "create_rule", boom)
    resp = handler.lambda_handler(
        _event("POST", "/enrichments", {"value": "X", "categoryId": "c"}), None)
    assert resp["statusCode"] == 400


def test_create_enrichment_auth_failure_upstream_is_502(handler, monkeypatch):
    # A 401 on OUR key is an upstream misconfig, not the caller's fault.
    def boom(*a):
        raise handler.BankSyncError(401)

    monkeypatch.setattr(handler, "create_rule", boom)
    resp = handler.lambda_handler(
        _event("POST", "/enrichments", {"value": "X", "categoryId": "c"}), None)
    assert resp["statusCode"] == 502


def test_delete_enrichment_happy_path(handler, monkeypatch):
    deleted = []
    monkeypatch.setattr(handler, "delete_rule", lambda eid: deleted.append(eid))

    resp = handler.lambda_handler(
        _event("DELETE", "/enrichments/enr_1", path_params={"id": "enr_1"}), None)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"id": "enr_1"}
    assert deleted == ["enr_1"]


def test_delete_enrichment_missing_id_404(handler):
    resp = handler.lambda_handler(
        _event("DELETE", "/enrichments/", path_params={}), None)
    assert resp["statusCode"] == 404


# --- update (PUT) ------------------------------------------------------------


def test_update_rule_builds_correct_put_payload(enrichments, monkeypatch):
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["req"] = req
        return _FakeResponse({"success": True, "data": {"id": "enr_1"}})

    monkeypatch.setattr(enrichments.urllib.request, "urlopen", fake_urlopen)

    rule = enrichments.update_rule("enr_1", "description", "contains", "NETFLIX", "subs")

    req = captured["req"]
    assert req.method == "PUT"
    assert req.full_url == "https://api.banksync.io/v1/enrichments/enr_1"
    assert req.get_header("X-api-key") == "test-api-key"
    assert req.get_header("User-agent") == "abundo-app-api"

    sent = json.loads(req.data)
    assert sent["allFeeds"] is True
    leaf = sent["ruleConfig"]["rules"][0]["conditions"]["conditions"][0]
    assert leaf == {"field": "description", "operator": "contains", "value": "NETFLIX"}
    assert sent["ruleConfig"]["rules"][0]["action"] == {"field": "category", "value": "subs"}

    # id is the KNOWN enrichment id (not from the echo); same shape as create.
    assert rule == {"id": "enr_1", "field": "description", "operator": "contains",
                    "value": "NETFLIX", "categoryId": "subs"}


def test_update_rule_404_propagates(enrichments, monkeypatch):
    # Unlike delete_rule, update must NOT swallow 404 — editing a gone rule is an
    # error the handler turns into a 404.
    monkeypatch.setattr(
        enrichments.urllib.request, "urlopen",
        lambda req, timeout=None: (_ for _ in ()).throw(_http_error(enrichments, 404)))
    with pytest.raises(enrichments.BankSyncError) as excinfo:
        enrichments.update_rule("gone", "description", "contains", "X", "c")
    assert excinfo.value.upstream_status == 404


def test_update_enrichment_happy_path_trims_and_defaults(handler, monkeypatch):
    captured = {}

    def fake_update(eid, field, operator, value, category_id):
        captured.update(eid=eid, field=field, operator=operator, value=value, category_id=category_id)
        return {"id": eid, "field": field, "operator": operator, "value": value, "categoryId": category_id}

    monkeypatch.setattr(handler, "update_rule", fake_update)

    resp = handler.lambda_handler(
        _event("PUT", "/enrichments/enr_1", {"value": " NETFLIX ", "categoryId": " subs "},
               path_params={"id": "enr_1"}),
        None)

    assert resp["statusCode"] == 200
    # Same trim + defaulting as create, via the shared _validate_rule_body.
    assert captured == {"eid": "enr_1", "field": "description", "operator": "contains",
                        "value": "NETFLIX", "category_id": "subs"}


def test_update_enrichment_missing_id_404(handler):
    resp = handler.lambda_handler(
        _event("PUT", "/enrichments/", {"value": "X", "categoryId": "c"}, path_params={}), None)
    assert resp["statusCode"] == 404


def test_update_enrichment_missing_value_400(handler):
    resp = handler.lambda_handler(
        _event("PUT", "/enrichments/enr_1", {"categoryId": "c"}, path_params={"id": "enr_1"}), None)
    assert resp["statusCode"] == 400


def test_update_enrichment_unknown_rule_is_404(handler, monkeypatch):
    # A BankSync 404 on PUT (rule gone) surfaces as 404, not the default 502.
    def boom(*a):
        raise handler.BankSyncError(404)

    monkeypatch.setattr(handler, "update_rule", boom)
    resp = handler.lambda_handler(
        _event("PUT", "/enrichments/enr_1", {"value": "X", "categoryId": "c"}, path_params={"id": "enr_1"}), None)
    assert resp["statusCode"] == 404


def test_update_enrichment_bad_rule_upstream_is_400(handler, monkeypatch):
    monkeypatch.setattr(handler, "update_rule",
                        lambda *a: (_ for _ in ()).throw(handler.BankSyncError(422)))
    resp = handler.lambda_handler(
        _event("PUT", "/enrichments/enr_1", {"value": "X", "categoryId": "c"}, path_params={"id": "enr_1"}), None)
    assert resp["statusCode"] == 400


def test_update_enrichment_auth_failure_upstream_is_502(handler, monkeypatch):
    monkeypatch.setattr(handler, "update_rule",
                        lambda *a: (_ for _ in ()).throw(handler.BankSyncError(401)))
    resp = handler.lambda_handler(
        _event("PUT", "/enrichments/enr_1", {"value": "X", "categoryId": "c"}, path_params={"id": "enr_1"}), None)
    assert resp["statusCode"] == 502
