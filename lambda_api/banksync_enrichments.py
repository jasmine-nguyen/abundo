"""BankSync Enrichments client + Rule adapter (WHIT-52, Slice 1).

BankSync runs a server-side rule engine (the Enrichments API) that labels
transactions at sync time, BEFORE they reach our webhook. This module is the
adapter between BankSync's verbose `enrichment` shape and the app's tiny `Rule`
shape, so BankSync's vocabulary never leaks to the client:

    our Rule            BankSync enrichment
    ----------------    ------------------------------------------------------
    {id, field,         {id, name, type:"rule", dataType:"transactions",
     operator, value,    allFeeds, ruleConfig:{rules:[{conditions:{logic,
     categoryId}          conditions:[{field,operator,value}]},
                          action:{field:"category", value:<categoryId>}}]}}

BankSync is the source of truth — we store no rules of our own; list/create/
delete all proxy straight through. One BankSync enrichment == one Abundo Rule
(so `Rule.id` is the enrichment id and delete/list map 1:1).

The urllib + SSM + custom-User-Agent pattern mirrors lambda_sync_trigger; the
User-Agent is load-bearing (Cloudflare 403s the default urllib agent). Both
`constants` and `ssm` are provided by the shared lambda layer.
"""

import json
import urllib.error
import urllib.request

from constants import (
    BANKSYNC_API_KEY_PATH,
    BANKSYNC_BASE_URL,
    BANKSYNC_TIMEOUT_SECONDS,
    BANKSYNC_USER_AGENT,
)
from ssm import get_param

_ENRICHMENTS = "/v1/enrichments"

_api_key = None


class BankSyncError(Exception):
    """A failed BankSync call. `upstream_status` is BankSync's HTTP status, or
    None for a network/transport failure (timeout, DNS). The handler maps this to
    the status WE return to the app."""

    def __init__(self, upstream_status, message=""):
        super().__init__(message)
        self.upstream_status = upstream_status


def get_api_key() -> str:
    """Fetch and cache the BankSync API key from SSM for the life of the container."""
    global _api_key
    if _api_key is None:
        _api_key = get_param(BANKSYNC_API_KEY_PATH)
    return _api_key


def _request(method: str, path: str, body: dict | None = None) -> dict:
    """Make a BankSync REST call and return the decoded JSON body ({} if empty).

    Raises BankSyncError on any non-2xx (carrying the upstream status) or on a
    transport failure (upstream_status=None). The API key is attached here so no
    caller can forget it, and it is never included in the raised error.
    """
    url = f"{BANKSYNC_BASE_URL}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "X-API-Key": get_api_key(),
            "User-Agent": BANKSYNC_USER_AGENT,
            "Content-Type": "application/json",
        },
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=BANKSYNC_TIMEOUT_SECONDS) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raise BankSyncError(e.code, f"BankSync {method} {path} -> {e.code}") from e
    except urllib.error.URLError as e:
        raise BankSyncError(None, f"BankSync {method} {path} unreachable") from e


def _to_rule(enrichment: dict) -> dict | None:
    """Map one BankSync enrichment to our Rule shape, or None if it doesn't fit.

    BankSync (or its Memory tier) can hold enrichments we didn't author — coarser
    rules, multi-condition groups, non-category actions. Rather than crash the
    list, we skip anything that isn't a single-leaf `<field> <op> <value>` ->
    set-category rule. Defensive against every missing key / wrong type.
    """
    try:
        rules = (enrichment.get("ruleConfig") or {}).get("rules") or []
        if not rules:
            return None
        rule = rules[0]
        action = rule.get("action") or {}
        if action.get("field") != "category":
            return None
        category_id = action.get("value")
        if not category_id:
            return None
        leaves = (rule.get("conditions") or {}).get("conditions") or []
        if not leaves:
            return None
        leaf = leaves[0]
        # A nested ConditionGroup has "logic"/"conditions", not "field" — skip it.
        field = leaf.get("field")
        operator = leaf.get("operator")
        value = leaf.get("value")
        if not field or not operator or value is None:
            return None
        return {
            "id": enrichment.get("id"),
            "field": field,
            "operator": operator,
            "value": value,
            "categoryId": category_id,
        }
    except (AttributeError, TypeError, IndexError):
        return None


def list_rules() -> list[dict]:
    """GET /v1/enrichments — every categorisation rule, as our Rule shape.

    Filters to type "rule" and skips any enrichment that doesn't map to our
    single-condition shape (see _to_rule), so foreign/coarse rules never break
    the app.
    """
    payload = _request("GET", _ENRICHMENTS)
    enrichments = payload.get("data") or []
    rules = []
    for enr in enrichments:
        if (enr or {}).get("type") != "rule":
            continue
        rule = _to_rule(enr)
        if rule is not None:
            rules.append(rule)
    return rules


def _rule_payload(field: str, operator: str, value: str, category_id: str) -> dict:
    """The BankSync enrichment body for a single-condition rule
    `<field> <operator> <value>` -> set category=<category_id>, applied to all
    feeds. Shared by create and update so the two can't diverge on shape."""
    return {
        "name": f"{field} {operator} {value} -> {category_id}",
        "type": "rule",
        "dataType": "transactions",
        "allFeeds": True,
        "ruleConfig": {
            "rules": [
                {
                    "conditions": {
                        "logic": "and",
                        "conditions": [
                            {"field": field, "operator": operator, "value": value}
                        ],
                    },
                    "action": {"field": "category", "value": category_id},
                }
            ]
        },
    }


def create_rule(field: str, operator: str, value: str, category_id: str) -> dict:
    """POST /v1/enrichments — create a single-condition categorisation rule.

    Returns the new Rule (id from BankSync + the inputs), so the caller doesn't
    depend on BankSync echoing the ruleConfig back.
    """
    result = _request("POST", _ENRICHMENTS, _rule_payload(field, operator, value, category_id))
    created = result.get("data") or {}
    return {
        "id": created.get("id"),
        "field": field,
        "operator": operator,
        "value": value,
        "categoryId": category_id,
    }


def update_rule(enrichment_id: str, field: str, operator: str, value: str, category_id: str) -> dict:
    """PUT /v1/enrichments/{id} — replace a rule's config (full replace, so we
    always send the whole ruleConfig). Returns the Rule from the inputs (the id is
    the known enrichment_id). Unlike delete_rule, a 404 is NOT swallowed — the
    handler maps it to a 404 for the app (editing a rule that's gone is an error,
    not a no-op)."""
    _request("PUT", f"{_ENRICHMENTS}/{enrichment_id}", _rule_payload(field, operator, value, category_id))
    return {
        "id": enrichment_id,
        "field": field,
        "operator": operator,
        "value": value,
        "categoryId": category_id,
    }


def delete_rule(enrichment_id: str) -> None:
    """DELETE /v1/enrichments/{id}. A 404 (already gone) is treated as success so
    deleting a stale/unknown rule is idempotent rather than an error."""
    try:
        _request("DELETE", f"{_ENRICHMENTS}/{enrichment_id}")
    except BankSyncError as e:
        if e.upstream_status == 404:
            return
        raise
