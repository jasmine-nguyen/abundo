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
import re
import urllib.error
import urllib.request

from constants import (
    BANKSYNC_API_KEY_PATH,
    BANKSYNC_BASE_URL,
    BANKSYNC_TIMEOUT_SECONDS,
    BANKSYNC_USER_AGENT,
)
from api_key import get_api_key as _fetch_api_key

_ENRICHMENTS = "/v1/enrichments"


class BankSyncError(Exception):
    """A failed BankSync call. `upstream_status` is BankSync's HTTP status, or
    None for a network/transport failure (timeout, DNS). The handler maps this to
    the status WE return to the app."""

    def __init__(self, upstream_status, message=""):
        super().__init__(message)
        self.upstream_status = upstream_status


def get_api_key() -> str:
    """The BankSync API key (fetched + cached in shared/api_key.py, keyed by path)."""
    return _fetch_api_key(BANKSYNC_API_KEY_PATH)


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
            # How many conditions the source enrichment REALLY had. We only read the first
            # leaf, so a foreign "description contains UBER AND amount > 50" would read as the
            # much broader "description contains UBER". Harmless while rules are only listed,
            # but applying that broadened rule to stored history would mis-file every Uber
            # charge — so rule_apply refuses to act on anything but a true single-leaf rule.
            "conditionCount": len(leaves),
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


def _fold(value: str) -> str:
    """Fold a rule value for duplicate-matching, mirroring the client's
    normaliseRuleIdentity (src/context.tsx): trim, lowercase, collapse internal
    whitespace runs. Case + spacing vary for the same merchant, so an exact-value
    compare would miss real duplicates. `str(...)` guards a non-string value from a
    foreign enrichment so the fail-open lookup can't raise. The two folds are only
    guaranteed equal for ASCII (Python `.lower()` and JS `toLowerCase()` disagree on
    a few non-ASCII chars) — fine for the AU merchant strings this matches."""
    return re.sub(r"\s+", " ", str(value or "").strip().lower())


def _rule_identity(field: str, operator: str, value: str, category_id: str) -> tuple:
    """The dedup key for a rule. Only `value` is folded; field/operator/category_id
    stay EXACT — the client may send a non-default field/operator (RULE_FIELDS /
    RULE_OPERATORS), which target different text or set a different action, so
    folding them together would wrongly merge genuinely different rules."""
    return (field, operator, _fold(value), category_id)


def rule_targets_same_text(rule: dict, field: str, operator: str, value: str) -> bool:
    """Would this existing rule match exactly the charges `<field> <operator> <value>` matches?

    The value half of _rule_identity, WITHOUT the category — so a caller can find a rule that
    targets the same text but files it somewhere else. That pair is the damaging case: two rules
    disagreeing over the same charges leaves them conflicted, and conflicted charges are never
    filed (rule_apply), on this run or any future one.
    """
    return (rule.get("field"), rule.get("operator"), _fold(rule.get("value"))) == (
        field, operator, _fold(value))


def create_rule(field: str, operator: str, value: str, category_id: str) -> dict:
    """POST /v1/enrichments — create a single-condition categorisation rule.

    WHIT-497: idempotent on rule identity. Before creating, look up existing rules
    and return a match instead of minting a duplicate — the client's own guard runs
    only against its in-memory rule cache, which is empty when the Rules screen was
    never opened, so a re-tap or cold cache would otherwise pile up duplicate rules.

    Returns the new Rule (id from BankSync + the inputs), so the caller doesn't
    depend on BankSync echoing the ruleConfig back.
    """
    identity = _rule_identity(field, operator, value, category_id)
    # Fail OPEN: a failed READ must never block the WRITE. If the lookup errors we
    # skip the dedup and create as before (worst case: the one duplicate we already
    # tolerate today). The concurrent per-mint creates (context.tsx) make a hard
    # dependency on the lookup a real regression risk, so we swallow BankSyncError.
    # Best-effort scope: list_rules reads only the first page of enrichments, so a
    # duplicate beyond page 1 (a very large rule set) can still slip through — an
    # accepted limit for this clutter-reduction fix (WHIT-497).
    try:
        for existing in list_rules():
            if _rule_identity(
                existing["field"], existing["operator"], existing["value"], existing["categoryId"]
            ) == identity:
                return existing
    except BankSyncError:
        pass

    result = _request("POST", _ENRICHMENTS, _rule_payload(field, operator, value, category_id))
    created = result.get("data") or {}
    return {
        "id": created.get("id"),
        "field": field,
        "operator": operator,
        "value": value,
        "categoryId": category_id,
        # A rule we mint always has exactly one condition (_rule_payload builds one leaf), so
        # the shape matches _to_rule's and rule_apply can act on it.
        "conditionCount": 1,
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
        "conditionCount": 1,  # _rule_payload builds exactly one leaf (see create_rule)
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
