"""ADVERSARIAL gap tests for WHIT-531 — the apply-rules repoint from BankSync's capped rule
list onto our own RuleRepository.

These do NOT duplicate the four rewritten apply-rules suites (test_apply_rules*.py). Those lock
the sweep/mint/clash behaviour end to end. This file probes the SEAMS the repoint
introduced, which those suites do not isolate:

  * [G1] rule_reply(rule_from_row(row)) maps a store row (snake_case) to the client shape and reads
    `category_id`, never a stray `categoryId`; it is the ONLY snake->camel translation.
  * [G2] the mapper never raises on a sparse/oversupplied row, and never leaks `category_id`
    downstream (a downstream reader of `category_id` would silently see None post-map).
  * [G4] the clash guard reads the FULL store list — a clash on a rule PAST BankSync's old
    100-row first page is still found (the whole point of the repoint).
  * [G5] a rules-read failure on a PREVIEW (the default) is a 500 too, not only on a write run.

Drives the real RuleRepository and TransactionRepository over one FakeTable (WHIT-625). The
clash/read-failure paths return before the history scan, which the table's query log proves.
"""

import json
from decimal import Decimal

from _feed_fakes import apply_rules_event, FakeCategoryRepo, date_queries, real_repos
from _rule_ingest_fakes import apply_rules_to_uncategorized


def _stored_rule(value, category_id, *, field="description", operator="contains"):
    # The kwargs of one real RuleRepository.create_rule call — the store mints the id.
    return {"field": field, "operator": operator, "value": value, "category_id": category_id}


# --- [G1]-[G3] the boundary mapper -----------------------------------------------------------


def _to_client(row):
    # WHIT-623: the store row -> engine shape (rule_from_row) -> app reply (rule_reply).
    import rule_book

    return rule_book.rule_reply(rule_book.rule_from_row(row))


def test_rule_reply_reads_snake_case_category_id_not_a_stray_camel_case(handler):
    # [G1] FAIL-ON-REVERT for the mapper's SOURCE field. The store speaks `category_id`; the
    # client shape is `categoryId`. A row that (perversely) also carries a stray `categoryId`
    # must be ignored — the mapper must read `category_id`. Swap `row.get("category_id")` for
    # `row.get("categoryId")` and this reddens (petrol would win over groceries).
    mapped = _to_client({
        "id": "r1", "field": "description", "operator": "contains", "value": "COLES",
        "category_id": "groceries", "categoryId": "petrol"})

    assert mapped["categoryId"] == "groceries"
    assert "category_id" not in mapped     # [G2] nothing downstream can read the snake_case key


def test_rule_reply_maps_a_full_store_row_to_exactly_the_client_shape(handler):
    # [G1]/[G2] A real store row carries pk/sk/source/created_at/updated_at. The mapper must
    # project to EXACTLY the engine/client keys and drop the rest — a leaked store key downstream
    # is a silent shape drift.
    conditions = [{"field": "merchant", "operator": "contains", "value": "ALDI"},
                  {"field": "amount", "operator": "less_than", "value": "40"}]
    mapped = _to_client({
        "pk": "RULE", "sk": "RULE#abc", "id": "abc", "field": "merchant",
        "operator": "contains", "value": "ALDI", "category_id": "groceries",
        "budget_excluded": True, "spread": True, "spread_amount": Decimal("42.50"),
        "spread_gap_days": 30, "spread_seeded": False,
        "conditions": conditions, "logic": "all", "source": "app",
        "created_at": "2026-01-01T00:00:00+00:00", "updated_at": "2026-01-02T00:00:00+00:00"})

    assert mapped == {"id": "abc", "field": "merchant", "operator": "contains",
                      "value": "ALDI", "categoryId": "groceries", "budgetExcluded": True,
                      "spread": True, "spreadAmount": Decimal("42.50"), "spreadGapDays": 30,
                      "conditions": conditions, "logic": "all"}


def test_rule_reply_never_raises_on_a_sparse_row(handler):
    # [G2] A half-migrated / foreign row missing keys must map to None fields, never KeyError —
    # a subscript here would 500 the whole run. rule_engine._skip_reason then handles the None.
    mapped = _to_client({})

    assert mapped == {"id": None, "field": None, "operator": None, "value": None,
                      "categoryId": None, "budgetExcluded": False,
                      "spread": False, "spreadAmount": None, "spreadGapDays": None,
                      "conditions": None, "logic": None}


# --- [G4] the clash guard reads the WHOLE store, not a capped first page ----------------------


def test_a_clash_on_a_rule_past_the_old_100_row_page_is_still_found(handler):
    # [G4] FAIL-ON-REVERT for the reason the card exists. BankSync capped list_rules at 100; our
    # store is uncapped. Seed 150 unrelated rules plus a COLES->petrol clash that the store lists
    # past row 100 (rules list in id order). A preview of COLES->groceries must 409 on it.
    # Reintroduce a `[:100]` slice on the read and the clash is dropped -> the preview proceeds and
    # returns 200 -> red. A PREVIEW deliberately:
    # it never mints, so create_rule's own dedup can't backstop a dropped pre-scan clash.
    rules = [_stored_rule(f"SHOP-{i:03d}-ZZ", "petrol") for i in range(150)]
    rules.append(_stored_rule("COLES", "petrol"))
    _, repo, rule_repo = real_repos(rules=rules)
    listed = rule_repo.list_rules()
    clash = next(rule for rule in listed if rule["value"] == "COLES")
    assert listed.index(clash) >= 100                        # the premise: past the old page

    resp = apply_rules_to_uncategorized(
        handler,
        apply_rules_event({"dryRun": True, "rule": {"value": "COLES", "categoryId": "groceries"}}),
        repo, FakeCategoryRepo(["groceries", "petrol"]), rule_repo)
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 409
    assert body["existingRule"]["id"] == clash["id"]
    assert body["existingRule"]["categoryId"] == "petrol"   # mapped from category_id
    assert len(rule_repo.list_rules()) == 151                # nothing minted


def test_the_full_store_read_covers_a_NESTED_clash_beyond_the_first_page(handler):
    # [G4] The nested variant (containment, not equality) is the shape an equality-only or capped
    # read is likeliest to miss. An existing "COLES EXPRESS"->petrol far down the list overlaps an
    # inline "COLES"->groceries, so the preview must 409.
    rules = [_stored_rule(f"SHOP-{i:03d}-ZZ", "petrol") for i in range(400)]
    rules.append(_stored_rule("COLES EXPRESS", "petrol"))
    _, repo, rule_repo = real_repos(rules=rules)
    listed = rule_repo.list_rules()
    nested = next(rule for rule in listed if rule["value"] == "COLES EXPRESS")
    assert listed.index(nested) >= 100                       # the premise: past the old page

    resp = apply_rules_to_uncategorized(
        handler,
        apply_rules_event({"dryRun": True, "rule": {"value": "COLES", "categoryId": "groceries"}}),
        repo, FakeCategoryRepo(["groceries", "petrol"]), rule_repo)
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 409
    assert body["existingRule"]["id"] == nested["id"]


# --- [G5] a rules-read failure is OUR 500 on the PREVIEW path too ----------------------------


def test_a_rules_read_failure_on_a_preview_is_a_500_and_scans_no_history(handler):
    # [G5] The sibling suite proves the read-failure 500 on a WRITE run; preview is the DEFAULT
    # button, and the read happens before the dry-run split, so a preview read failure must 500
    # too (our DB) and never reach the history scan.
    table, repo, rule_repo = real_repos()
    table.fail("query")

    resp = apply_rules_to_uncategorized(
        handler,
        apply_rules_event({"dryRun": True}), repo, FakeCategoryRepo(["groceries"]), rule_repo)

    assert resp["statusCode"] == 500
    assert json.loads(resp["body"])["error"] == "could not read your rules"
    assert date_queries(table) == []
