"""ADVERSARIAL gap tests for WHIT-531 — the apply-rules repoint from BankSync's capped rule
list onto our own RuleRepository.

These do NOT duplicate the four rewritten apply-rules suites (test_apply_rules*.py). Those lock
the sweep/mint/clash behaviour through FakeRuleRepo. This file probes the SEAMS the repoint
introduced, which those suites do not isolate:

  * [G1] _rule_to_client maps a store row (snake_case) to the client shape and reads
    `category_id`, never a stray `categoryId`; it is the ONLY snake->camel translation.
  * [G2] the mapper never raises on a sparse/oversupplied row, and never leaks `category_id`
    downstream (a downstream reader of `category_id` would silently see None post-map).
  * [G4] the clash guard reads the FULL store list — a clash on a rule PAST BankSync's old
    100-row first page is still found (the whole point of the repoint).
  * [G5] a rules-read failure on a PREVIEW (the default) is a 500 too, not only on a write run.

Drives FakeRuleRepo (WHIT-531). The clash/read-failure paths return before the history scan, so
the transaction repo here is a local no-scan / empty stub with DISTINCT names (never the shared
feed fakes) — this suite is registered only in the `rule` domain of test_fakes_invariants.py.
"""

import json

from _rule_fakes import FakeRuleRepo


class _Taxonomy:
    """Minimal CategoryRepository stand-in: just the ids the validator/skip checks read."""

    def __init__(self, ids):
        self._ids = set(ids)

    def list_categories(self):
        return [{"id": cid} for cid in self._ids]


class _NoScanRepo:
    """A transaction repo that must never be scanned — the clash/read-failure paths return
    before the history scan, so any read here is a bug in that ordering."""

    def get_transactions_by_date_range(self, *args, **kwargs):
        raise AssertionError("history must not be scanned before the clash/read-failure return")


class _EmptyTxns:
    """A transaction repo with no rows — for the preview path that DOES reach the scan."""

    def get_transactions_by_date_range(self, account_id, start, end, limit=None, cursor=None):
        return [], None


def _store_row(value, category_id, *, rule_id=None, field="description", operator="contains",
               **extra):
    row = {"id": rule_id, "field": field, "operator": operator, "value": value,
           "category_id": category_id}
    row.update(extra)
    return row


def _event(body):
    return {
        "rawPath": "/transactions/uncategorized/apply-rules",
        "requestContext": {"http": {"method": "POST"}},
        "body": json.dumps(body),
    }


# --- [G1]-[G3] the boundary mapper -----------------------------------------------------------


def test_rule_to_client_reads_snake_case_category_id_not_a_stray_camel_case(handler):
    # [G1] FAIL-ON-REVERT for the mapper's SOURCE field. The store speaks `category_id`; the
    # client shape is `categoryId`. A row that (perversely) also carries a stray `categoryId`
    # must be ignored — the mapper must read `category_id`. Swap `row.get("category_id")` for
    # `row.get("categoryId")` and this reddens (petrol would win over groceries).
    mapped = handler._rule_to_client({
        "id": "r1", "field": "description", "operator": "contains", "value": "COLES",
        "category_id": "groceries", "categoryId": "petrol"})

    assert mapped["categoryId"] == "groceries"
    assert "category_id" not in mapped     # [G2] nothing downstream can read the snake_case key


def test_rule_to_client_maps_a_full_store_row_to_exactly_the_client_shape(handler):
    # [G1]/[G2] A real store row carries pk/sk/source/created_at/updated_at. The mapper must
    # project to EXACTLY the engine/client keys and drop the rest — a leaked store key downstream
    # is a silent shape drift.
    mapped = handler._rule_to_client({
        "pk": "RULE", "sk": "RULE#abc", "id": "abc", "field": "description",
        "operator": "contains", "value": "ALDI", "category_id": "groceries",
        "budget_excluded": True, "source": "app",
        "created_at": "2026-01-01T00:00:00+00:00", "updated_at": "2026-01-02T00:00:00+00:00"})

    assert mapped == {"id": "abc", "field": "description", "operator": "contains",
                      "value": "ALDI", "categoryId": "groceries", "budgetExcluded": True}


def test_rule_to_client_never_raises_on_a_sparse_row(handler):
    # [G2] A half-migrated / foreign row missing keys must map to None fields, never KeyError —
    # a subscript here would 500 the whole run. rule_engine._skip_reason then handles the None.
    mapped = handler._rule_to_client({})

    assert mapped == {"id": None, "field": None, "operator": None, "value": None,
                      "categoryId": None, "budgetExcluded": False}


# --- [G4] the clash guard reads the WHOLE store, not a capped first page ----------------------


def test_a_clash_on_a_rule_past_the_old_100_row_page_is_still_found(handler):
    # [G4] FAIL-ON-REVERT for the reason the card exists. BankSync capped list_rules at 100; our
    # store is uncapped. Seed 150 unrelated rules, then a COLES->petrol clash LAST. A preview of
    # COLES->groceries must 409 on it. Reintroduce a `[:100]` slice on the read and the clash
    # (row 151) is dropped -> the preview proceeds and returns 200 -> red. A PREVIEW deliberately:
    # it never mints, so create_rule's own dedup can't backstop a dropped pre-scan clash.
    rules = [_store_row(f"SHOP-{i:03d}-ZZ", "petrol", rule_id=f"d{i}") for i in range(150)]
    rules.append(_store_row("COLES", "petrol", rule_id="clash"))
    rule_repo = FakeRuleRepo(rules=rules)

    resp = handler.apply_rules_to_uncategorized(
        _event({"dryRun": True, "rule": {"value": "COLES", "categoryId": "groceries"}}),
        _EmptyTxns(), _Taxonomy({"groceries", "petrol"}), rule_repo)
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 409
    assert body["existingRule"]["id"] == "clash"
    assert body["existingRule"]["categoryId"] == "petrol"   # mapped from category_id
    assert rule_repo.minted == []


def test_the_full_store_read_covers_a_NESTED_clash_beyond_the_first_page(handler):
    # [G4] The nested variant (containment, not equality) is the shape an equality-only or capped
    # read is likeliest to miss. An existing "COLES EXPRESS"->petrol far down the list overlaps an
    # inline "COLES"->groceries, so the preview must 409.
    rules = [_store_row(f"SHOP-{i:03d}-ZZ", "petrol", rule_id=f"d{i}") for i in range(140)]
    rules.append(_store_row("COLES EXPRESS", "petrol", rule_id="nested"))
    rule_repo = FakeRuleRepo(rules=rules)

    resp = handler.apply_rules_to_uncategorized(
        _event({"dryRun": True, "rule": {"value": "COLES", "categoryId": "groceries"}}),
        _EmptyTxns(), _Taxonomy({"groceries", "petrol"}), rule_repo)
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 409
    assert body["existingRule"]["id"] == "nested"


# --- [G5] a rules-read failure is OUR 500 on the PREVIEW path too ----------------------------


def test_a_rules_read_failure_on_a_preview_is_a_500_and_scans_no_history(handler):
    # [G5] The sibling suite proves the read-failure 500 on a WRITE run; preview is the DEFAULT
    # button, and the read happens before the dry-run split, so a preview read failure must 500
    # too (our DB) and never reach the history scan.
    rule_repo = FakeRuleRepo(list_error=True)

    resp = handler.apply_rules_to_uncategorized(
        _event({"dryRun": True}), _NoScanRepo(), _Taxonomy({"groceries"}), rule_repo)

    assert resp["statusCode"] == 500
    assert json.loads(resp["body"])["error"] == "could not read your rules"
