"""Adversarial GAP tests for scripts/import_banksync_rules.py (WHIT-532).

Independent half of the QA split — these cover the planner/execute edges the implementer's
script + repo tests do NOT: a mixed resolve/live group, prefer-ours on an app row / multiple /
a ghost id / a brand-new rule, the 99-vs-100 paging boundary, the pure "id moved to a different
row" branch, empty-BankSync partial cutover, and the full import-twice/delete-twice idempotency
chain. Nothing here duplicates an existing case.
"""

import pytest

T1, T2, T3, T4 = ("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z",
                  "2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z")


def enr(eid, value="WOOLWORTHS", category="groceries", *, field="description",
        operator="contains", type_="rule", leaves=None, action_field="category"):
    if leaves is None:
        leaves = [{"field": field, "operator": operator, "value": value}]
    return {
        "id": eid,
        "type": type_,
        "ruleConfig": {"rules": [{
            "conditions": {"logic": "and", "conditions": leaves},
            "action": {"field": action_field, "value": category},
        }]},
    }


def payload(*enrichments, **extra):
    return {"success": True, "data": list(enrichments), **extra}


def run(script, argv, response, *, delete=None, now=T1):
    return script.module.main(
        argv, repo=script.repo, category_repo=script.taxonomy(),
        fetch=lambda: response, delete_enrichment=delete or (lambda e: None),
        now=lambda: now,
    )


def rid(script, value, field="description", operator="contains"):
    return script.module.rule_engine.rule_id_for(field, operator, value)


def plan(script, source_payload, ours=(), ledger=None, prefer_ours=(),
         tax=("groceries", "petrol")):
    source = script.module.load_source_rules(source_payload, set(tax))
    return script.module.plan_import(source, list(ours), dict(ledger or {}), list(prefer_ours))


def import_row(script, value, category, *, eids, source="import", touched=False,
               field="description", operator="contains"):
    row_id = rid(script, value, field, operator)
    updated_at = T2 if touched else T1
    row = {"pk": "RULE", "sk": f"RULE#{row_id}", "id": row_id,
           "field": field, "operator": operator, "value": value, "category_id": category,
           "source": source, "created_at": T1, "updated_at": updated_at,
           "banksync_enrichment_ids": list(eids)}
    if source == "import":
        row["imported_at"] = T1
    return row


# --- load_source_rules: paging boundary the 100-case leaves open ----------------


def test_page_guard_99_entries_does_not_abort(script):
    ok = payload(*[enr(f"e{i}", value=f"m{i}") for i in range(99)])
    source = script.module.load_source_rules(ok, {"groceries"})
    assert len(source) == 99 and all(s.kind == "ok" for s in source)


def test_data_key_absent_entirely_aborts(script):
    with pytest.raises(script.module.PagingSuspected):
        script.module.load_source_rules({"success": True}, set())


# --- plan_import (pure): mixed groups + the "moved to another row" branches -------


def test_group_some_ids_resolve_some_live(script):
    rid_w = rid(script, "WOOLWORTHS")
    p = plan(script, payload(enr("e1", "WOOLWORTHS", "groceries"),
                             enr("e2", "WOOLWORTHS", "groceries")),
             ours=[], ledger={"e1": rid_w})
    creates = [a for a in p.actions if a.kind == "create"]
    assert len(creates) == 1
    assert tuple(creates[0].enrichment_ids) == ("e2",)
    assert {r["enrichment_id"] for r in p.report.resolved} == {"e1"}
    assert not p.blocked


def test_ledger_id_now_on_a_different_row_resolves_not_refuses(script):
    rid_a = rid(script, "WOOLWORTHS")
    row_b = import_row(script, "WOOLWORTHS METRO", "groceries", eids=["e1"])
    p = plan(script, payload(enr("e1", "WOOLWORTHS", "groceries")),
             ours=[row_b], ledger={"e1": rid_a})
    assert not [a for a in p.actions if a.kind == "create"]
    assert {r["enrichment_id"] for r in p.report.resolved} == {"e1"}
    assert not p.blocked


def test_income_category_flows_through_to_a_create(script):
    p = plan(script, payload(enr("e1", "PAYROLL", "income")), tax=("groceries",))
    creates = [a for a in p.actions if a.kind == "create"]
    assert len(creates) == 1 and creates[0].category_id == "income"


# --- plan_import (pure): --prefer-ours corners -----------------------------------


def test_prefer_ours_on_an_app_row_clears_and_stays_metadata_free(script):
    app_id = rid(script, "WOOLWORTHS")
    app_row = {"pk": "RULE", "sk": f"RULE#{app_id}", "id": app_id,
               "field": "description", "operator": "contains", "value": "WOOLWORTHS",
               "category_id": "groceries", "source": "app", "created_at": T1, "updated_at": T2,
               "banksync_enrichment_ids": ["e1"]}
    p = plan(script, payload(enr("e1", "WOOLWORTHS", "petrol")),
             ours=[app_row], prefer_ours=["e1"])
    assert not p.report.refused
    action = next(a for a in p.actions if a.rule_id == app_id)
    assert action.kind == "stamp" and tuple(action.enrichment_ids) == ()
    assert action.set_imported_at is False
    assert p.passive_bindings.get("e1") == app_id


def test_prefer_ours_multiple_ids_each_cleared_and_ledgered(script):
    row_w = import_row(script, "WOOLWORTHS", "groceries", eids=["e1"])
    row_b = import_row(script, "BP", "petrol", eids=["e2"])
    p = plan(script, payload(enr("e1", "WOOLWORTHS", "groceries"), enr("e2", "BP", "petrol")),
             ours=[row_w, row_b], prefer_ours=["e1", "e2"])
    stamps = {a.rule_id: a for a in p.actions if a.kind == "stamp"}
    assert set(stamps) == {rid(script, "WOOLWORTHS"), rid(script, "BP")}
    assert all(tuple(a.enrichment_ids) == () for a in stamps.values())
    assert p.passive_bindings == {"e1": rid(script, "WOOLWORTHS"), "e2": rid(script, "BP")}


def test_prefer_ours_of_a_ghost_id_is_a_harmless_no_op(script):
    p = plan(script, payload(enr("e1", "WOOLWORTHS", "groceries")),
             ours=[], prefer_ours=["ghost-not-anywhere"])
    assert "ghost-not-anywhere" not in p.passive_bindings
    assert [a.kind for a in p.actions] == ["create"]
    assert not p.blocked


def test_prefer_ours_of_a_brand_new_rule_imports_it_not_drops_it(script):
    # The footgun QA flagged: preferring-ours over a NEW BankSync rule with no counterpart of ours
    # must NOT drop it (that would delete it from both stores at cutover). It imports normally and
    # a warning is emitted. Fail-on-revert: drop the `row is not None or carriers.get(id)` guard
    # and the create disappears (the id is resolved + ledgered instead).
    p = plan(script, payload(enr("e1", "WOOLWORTHS", "groceries")),
             ours=[], prefer_ours=["e1"])
    assert [a.kind for a in p.actions] == ["create"]
    assert "e1" not in p.passive_bindings
    assert p.report.warnings and "e1" in p.report.warnings[0]


# --- delete mode: partial cutover + full idempotency chain -----------------------


def test_partial_cutover_empty_banksync_clears_and_schedules_stale_ids(script):
    app_id = rid(script, "MYER")
    app_row = {"pk": "RULE", "sk": f"RULE#{app_id}", "id": app_id,
               "field": "description", "operator": "contains", "value": "MYER",
               "category_id": "groceries", "source": "app", "created_at": T1, "updated_at": T2,
               "banksync_enrichment_ids": ["e9"]}
    source = script.module.load_source_rules(payload(), {"groceries"})
    imp = script.module.plan_import(source, [app_row], {}, [])
    dp = script.module.plan_delete(source, [app_row], {}, imp)
    assert dp.refusal is None
    assert [c[0] for c in dp.clears] == [app_id]
    assert dp.enrichment_ids == ["e9"]


def test_import_twice_then_delete_twice_is_fully_idempotent(script):
    response = payload(enr("e1", "WOOLWORTHS", "groceries"), enr("e3", "BP", "petrol"))
    run(script, ["import", "--apply"], response, now=T1)
    after_first_import = {k: dict(v) for k, v in script.table.store.items()}
    run(script, ["import", "--apply"], response, now=T2)
    assert script.table.store == after_first_import        # rerun import: zero writes

    d1 = script.delete_recorder()
    assert run(script, ["delete-from-banksync", "--apply", "--app-repointed"], response,
               delete=d1, now=T3) == 0
    assert set(d1.calls) == {"e1", "e3"}
    after_delete = {k: dict(v) for k, v in script.table.store.items()}

    d2 = script.delete_recorder()
    assert run(script, ["delete-from-banksync", "--apply", "--app-repointed"], payload(),
               delete=d2, now=T4) == 0
    assert d2.calls == []                                  # no double BankSync delete
    assert script.table.store == after_delete              # no further store writes
