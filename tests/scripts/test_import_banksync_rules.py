"""Import-mode tests for scripts/import_banksync_rules.py (WHIT-532).

The pure planner (`plan_import` / `load_source_rules`) carries most cases. The cases that must be
fail-on-revert against the STORE's real move/clash behaviour (an app text edit, a category edit)
drive the real RuleRepository through `main(--apply)` so a hand-built row can't hide the bug.
"""

import json
import pathlib

import pytest

T1, T2, T3 = "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z"
_FIXTURE = pathlib.Path(__file__).resolve().parents[1] / "fixtures" / "banksync_enrichments_list.json"


def enr(eid, value="WOOLWORTHS", category="groceries", *, field="description",
        operator="contains", type_="rule", leaves=None, action_field="category"):
    """A BankSync enrichment in the shape banksync_enrichments._to_rule reads."""
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


def run(script, argv, response, *, taxonomy=None, delete=None, now=T1):
    return script.module.main(
        argv, repo=script.repo, category_repo=taxonomy or script.taxonomy(),
        fetch=lambda: response, delete_enrichment=delete or (lambda e: None),
        now=lambda: now,
    )


def rid(script, value, field="description", operator="contains"):
    return script.module.rule_engine.rule_id_for(field, operator, value)


# --- load_source_rules ---------------------------------------------------------


def test_paging_guard_extra_key_aborts(script):
    with pytest.raises(script.module.PagingSuspected):
        script.module.load_source_rules({"success": True, "data": [], "next": "abc"}, set())


def test_paging_guard_full_page_aborts(script):
    full = payload(*[enr(f"e{i}", value=f"m{i}") for i in range(100)])
    with pytest.raises(script.module.PagingSuspected):
        script.module.load_source_rules(full, {"groceries"})


def test_paging_guard_known_envelope_keys_are_fine(script):
    # success + error are part of the normal envelope — they must NOT trip the guard.
    ok = {"success": True, "error": None, "data": [enr("e1")]}
    source = script.module.load_source_rules(ok, {"groceries"})
    assert [s.kind for s in source] == ["ok"]


def test_paging_confirmed_downgrades_to_warning(script, capsys):
    source = script.module.load_source_rules(
        {"success": True, "data": [enr("e1")], "meta": {}}, {"groceries"}, paging_confirmed=True)
    assert [s.kind for s in source] == ["ok"]
    assert "WARNING" in capsys.readouterr().out


def test_data_not_a_list_always_aborts(script):
    with pytest.raises(script.module.PagingSuspected):
        script.module.load_source_rules({"success": True, "data": {}}, set(), paging_confirmed=True)


def test_success_false_is_a_distinct_failure(script):
    with pytest.raises(script.module.BankSyncFailure):
        script.module.load_source_rules({"success": False, "error": "nope", "data": []}, set())


def test_success_false_without_data_is_a_failure_not_a_shape_guess(script):
    # A failure envelope often omits `data`. It must read as BankSyncFailure, not PagingSuspected —
    # fail-on-revert for the "check success before data-shape" ordering.
    with pytest.raises(script.module.BankSyncFailure):
        script.module.load_source_rules({"success": False, "error": "nope"}, set())


def test_classification_buckets(script):
    tax = {"groceries", "petrol"}
    source = script.module.load_source_rules(payload(
        enr("ok1", "COLES", "groceries"),
        enr("multi", "UBER", "petrol", leaves=[
            {"field": "description", "operator": "contains", "value": "UBER"},
            {"field": "amount", "operator": "gt", "value": "50"}]),
        enr("unsup", "X", "petrol", field="amount", operator="gt"),
        enr("unknown_cat", "BP", "nope"),
        enr("memo", "X", "groceries", action_field="memo"),
        enr("nested", "X", "groceries", leaves=[{"logic": "or", "conditions": []}]),
        enr("notrule", "X", "groceries", type_="memory"),
    ), tax)
    kinds = {s.enrichment_id: s.kind for s in source}
    assert kinds == {"ok1": "ok", "multi": "multi_condition", "unsup": "unsupported",
                     "unknown_cat": "unknown_category", "memo": "malformed",
                     "nested": "malformed", "notrule": "not_a_rule"}


def test_income_category_is_importable_not_unknown(script):
    # is_unfiled_category treats income as filed though it is not a taxonomy id — mirror the sweep.
    source = script.module.load_source_rules(payload(enr("e1", "PAYROLL", "income")), {"groceries"})
    assert source[0].kind == "ok"


# --- plan_import (pure) --------------------------------------------------------


def plan(script, source_payload, ours=(), ledger=None, prefer_ours=(), tax=("groceries", "petrol")):
    source = script.module.load_source_rules(source_payload, set(tax))
    return script.module.plan_import(source, list(ours), dict(ledger or {}), list(prefer_ours))


def test_fresh_import_creates(script):
    p = plan(script, payload(enr("e1", "WOOLWORTHS", "groceries"), enr("e3", "BP", "petrol")))
    kinds = sorted(a.kind for a in p.actions)
    assert kinds == ["create", "create"]
    assert not p.blocked


def test_whit497_duplicate_pair_folds_to_one_row(script):
    p = plan(script, payload(enr("e1", "COLES", "groceries"), enr("e2", "  coles ", "groceries")))
    assert len(p.actions) == 1
    assert set(p.actions[0].enrichment_ids) == {"e1", "e2"}


def test_disagreeing_pair_imports_none_and_blocks(script):
    p = plan(script, payload(enr("e1", "COLES", "groceries"), enr("e2", "COLES", "petrol")))
    assert p.actions == []
    assert p.report.disagreeing and p.blocked


def test_disagreeing_then_survivor_imports(script):
    # After Jas deletes one BankSync copy, the group agrees and the survivor imports.
    p = plan(script, payload(enr("e1", "COLES", "groceries")))
    assert [a.kind for a in p.actions] == ["create"]


def test_union_onto_app_row_keeps_it_metadata_free(script):
    app_row = {"id": rid(script, "WOOLWORTHS"), "field": "description", "operator": "contains",
               "value": "WOOLWORTHS", "category_id": "groceries", "source": "app",
               "created_at": T1, "updated_at": T1}
    p = plan(script, payload(enr("e1", "WOOLWORTHS", "groceries")), ours=[app_row])
    assert len(p.actions) == 1
    action = p.actions[0]
    assert action.kind == "stamp" and action.set_imported_at is False
    assert set(action.enrichment_ids) == {"e1"}


def test_bank_category_change_untouched_applies(script):
    row = {"id": rid(script, "WOOLWORTHS"), "field": "description", "operator": "contains",
           "value": "WOOLWORTHS", "category_id": "groceries", "source": "import",
           "imported_at": T1, "updated_at": T1, "banksync_enrichment_ids": ["e1"]}
    p = plan(script, payload(enr("e1", "WOOLWORTHS", "petrol")), ours=[row])
    action = p.actions[0]
    assert action.kind == "stamp" and action.category_id == "petrol"
    assert action.set_imported_at is True and action.expected_updated_at == T1


def test_bank_category_change_touched_refuses(script):
    row = {"id": rid(script, "WOOLWORTHS"), "field": "description", "operator": "contains",
           "value": "WOOLWORTHS", "category_id": "groceries", "source": "import",
           "imported_at": T1, "updated_at": T2, "banksync_enrichment_ids": ["e1"]}
    p = plan(script, payload(enr("e1", "WOOLWORTHS", "petrol")), ours=[row])
    assert p.actions == [] and p.report.refused and p.blocked


def test_bank_delete_untouched_deletes_ours(script):
    row = {"id": rid(script, "BP"), "field": "description", "operator": "contains",
           "value": "BP", "category_id": "petrol", "source": "import",
           "imported_at": T1, "updated_at": T1, "banksync_enrichment_ids": ["e3"]}
    p = plan(script, payload(enr("e1", "WOOLWORTHS", "groceries")), ours=[row])
    delete = [a for a in p.actions if a.kind == "delete"]
    assert delete and delete[0].rule_id == row["id"] and delete[0].expected_updated_at == T1


def test_bank_delete_touched_refuses(script):
    row = {"id": rid(script, "BP"), "field": "description", "operator": "contains",
           "value": "BP", "category_id": "petrol", "source": "import",
           "imported_at": T1, "updated_at": T2, "banksync_enrichment_ids": ["e3"]}
    p = plan(script, payload(enr("e1", "WOOLWORTHS", "groceries")), ours=[row])
    assert not [a for a in p.actions if a.kind == "delete"]
    assert p.report.refused and p.blocked


def test_app_delete_not_resurrected(script):
    # Row gone, id still in ledger -> resolved, no create.
    p = plan(script, payload(enr("e1", "WOOLWORTHS", "groceries")),
             ours=[], ledger={"e1": rid(script, "WOOLWORTHS")})
    assert p.actions == []
    assert p.report.resolved and not p.blocked


def test_bank_side_text_edit_untouched_refuses(script):
    # e1 still sits on the row we bound it to (ledger[e1]==that row) but BankSync now folds it
    # to a different text -> BankSync-side edit -> refuse, no create of the new text.
    old_id = rid(script, "WOOLWORTHS")
    row = {"id": old_id, "field": "description", "operator": "contains", "value": "WOOLWORTHS",
           "category_id": "groceries", "source": "import", "imported_at": T1, "updated_at": T1,
           "banksync_enrichment_ids": ["e1"]}
    p = plan(script, payload(enr("e1", "WOOLWORTHS METRO", "groceries")),
             ours=[row], ledger={"e1": old_id})
    assert not [a for a in p.actions if a.kind == "create"]
    assert p.report.refused and p.blocked


def test_category_edit_plus_bank_text_edit_refuses(script):
    # The case the touched-flag alone gets wrong: app recategorised the row (touched, id unchanged),
    # THEN BankSync's copy text changed. The ledger says e1 is still on the row we put it on, so it
    # is a BankSync-side edit -> refuse (not a silent drop).
    old_id = rid(script, "WOOLWORTHS")
    row = {"id": old_id, "field": "description", "operator": "contains", "value": "WOOLWORTHS",
           "category_id": "petrol", "source": "import", "imported_at": T1, "updated_at": T2,
           "banksync_enrichment_ids": ["e1"]}
    p = plan(script, payload(enr("e1", "WOOLWORTHS METRO", "groceries")),
             ours=[row], ledger={"e1": old_id})
    assert not [a for a in p.actions if a.kind == "create"]
    assert p.report.refused and p.blocked


def test_prefer_ours_on_import_row_clears_and_ledgers(script):
    old_id = rid(script, "WOOLWORTHS")
    row = {"id": old_id, "field": "description", "operator": "contains", "value": "WOOLWORTHS",
           "category_id": "groceries", "source": "import", "imported_at": T1, "updated_at": T2,
           "banksync_enrichment_ids": ["e1"]}
    p = plan(script, payload(enr("e1", "WOOLWORTHS METRO", "groceries")),
             ours=[row], ledger={"e1": old_id}, prefer_ours=["e1"])
    assert not p.report.refused
    action = next(a for a in p.actions if a.rule_id == old_id)
    assert action.kind == "stamp" and tuple(action.enrichment_ids) == ()
    assert action.set_imported_at is False              # a touched row stays touched
    assert p.passive_bindings.get("e1") == old_id


def test_ledger_heal_on_present_row(script):
    row = {"id": rid(script, "WOOLWORTHS"), "field": "description", "operator": "contains",
           "value": "WOOLWORTHS", "category_id": "groceries", "source": "import",
           "imported_at": T1, "updated_at": T1, "banksync_enrichment_ids": ["e1"]}
    p = plan(script, payload(enr("e1", "WOOLWORTHS", "groceries")), ours=[row], ledger={})
    assert p.actions == [] and p.report.present
    assert p.passive_bindings == {"e1": row["id"]}


# --- end to end through main() (real repository) -------------------------------


def test_main_apply_creates_rows_and_ledgers(script):
    code = run(script, ["import", "--apply"],
               payload(enr("e1", "WOOLWORTHS", "groceries"), enr("e3", "BP", "petrol")))
    assert code == 0
    assert len(script.repo.list_rules()) == 2
    assert set(script.repo.get_import_ledger()) == {"e1", "e3"}


def test_main_rerun_is_a_true_no_op(script):
    response = payload(enr("e1", "WOOLWORTHS", "groceries"), enr("e3", "BP", "petrol"))
    run(script, ["import", "--apply"], response, now=T1)
    before = {k: dict(v) for k, v in script.table.store.items()}
    run(script, ["import", "--apply"], response, now=T2)
    assert script.table.store == before          # not one write on the rerun


def test_main_preview_writes_nothing(script):
    code = run(script, ["import"], payload(enr("e1", "WOOLWORTHS", "groceries")))
    assert code == 0
    assert script.table.store == {}              # Taxonomy raises if any category write is attempted


def test_main_app_text_edit_not_resurrected_real_repo(script):
    # FAIL-ON-REVERT for the BLOCKER: build "ours" by driving the real update_rule (which MOVES the
    # row and carries the id) between two import runs. If plan_import judged "resolved" against every
    # row instead of the row at the group's own id, the rerun would re-create the old text -> 2 rows.
    run(script, ["import", "--apply"], payload(enr("e1", "WOOLWORTHS", "groceries")), now=T1)
    original_id = rid(script, "WOOLWORTHS")
    script.repo.update_rule(original_id, "description", "contains", "WOOLWORTHS METRO", "groceries")
    assert len(script.repo.list_rules()) == 1

    run(script, ["import", "--apply"], payload(enr("e1", "WOOLWORTHS", "groceries")), now=T2)
    rows = script.repo.list_rules()
    assert len(rows) == 1                                   # old text NOT re-created
    assert rows[0]["value"] == "WOOLWORTHS METRO"


def test_main_step4_applied_then_rerun_still_untouched(script):
    run(script, ["import", "--apply"], payload(enr("e1", "WOOLWORTHS", "groceries")), now=T1)
    run(script, ["import", "--apply"], payload(enr("e1", "WOOLWORTHS", "petrol")), now=T2)
    row = script.repo.list_rules()[0]
    assert row["category_id"] == "petrol" and row["updated_at"] == row["imported_at"] == T2
    before = {k: dict(v) for k, v in script.table.store.items()}
    run(script, ["import", "--apply"], payload(enr("e1", "WOOLWORTHS", "petrol")), now=T3)
    assert script.table.store == before                    # still untouched -> no write


def test_main_failed_create_not_ledgered_then_heals(script):
    response = payload(enr("e1", "WOOLWORTHS", "groceries"), enr("e3", "BP", "petrol"))
    bad_id = rid(script, "WOOLWORTHS")
    real_put = script.table.put_item

    def put(Item, ConditionExpression=None):
        if Item.get("id") == bad_id:
            raise _client_error(script)
        return real_put(Item, ConditionExpression=ConditionExpression)

    script.table.put_item = put
    code = run(script, ["import", "--apply"], response, now=T1)
    assert code == 1                                       # a failure -> non-zero
    assert set(script.repo.get_import_ledger()) == {"e3"}  # only the row that landed is ledgered

    script.table.put_item = real_put
    run(script, ["import", "--apply"], response, now=T2)
    assert set(script.repo.get_import_ledger()) == {"e1", "e3"}
    assert len(script.repo.list_rules()) == 2


def test_main_banksync_error_on_list_writes_nothing(script):
    def boom():
        raise script.module.BankSyncError(503, "down")
    code = script.module.main(
        ["import", "--apply"], repo=script.repo, category_repo=script.taxonomy(),
        fetch=boom, delete_enrichment=lambda e: None, now=lambda: T1)
    assert code == 1 and script.table.store == {}


def test_main_missing_env_exits_2(script, monkeypatch):
    monkeypatch.delenv("TABLE_NAME", raising=False)
    # No injected deps -> real path runs _require_env first and bails before importing a repository.
    assert script.module.main(["import"]) == 2


def test_argparse_bad_and_missing_mode(script):
    with pytest.raises(SystemExit):
        script.module.main(["bogus"])
    with pytest.raises(SystemExit):
        script.module.main([])


def test_recorded_fixture_preview_buckets_every_row(script):
    # Exercises the whole recorded-shape fixture end to end: the WHIT-497 pair folds to one create,
    # the disagreeing pair blocks, and each foreign shape lands in the right bucket.
    fixture = json.loads(_FIXTURE.read_text())
    # paging_confirmed to wave past the fixture's own "_comment" doc key (a real response has none).
    source = script.module.load_source_rules(
        fixture, {"groceries", "petrol", "dining"}, paging_confirmed=True)
    p = script.module.plan_import(source, [], {}, [])
    assert len(p.report.imported) == 2                     # WOOLWORTHS (folded pair) + BP
    woolies = next(line for line in p.report.imported if line["value"] == "WOOLWORTHS")
    assert set(woolies["enrichment_ids"]) == {"enr_woolies_1", "enr_woolies_2"}
    assert {line["enrichment_id"] for line in p.report.non_importable_deleted} == {"enr_multi", "enr_unsupported"}
    assert {line["enrichment_id"] for line in p.report.non_importable_listed} == {
        "enr_memo_action", "enr_nested_group", "enr_unknown_category"}
    assert [line["enrichment_id"] for line in p.report.ignored] == ["enr_not_a_rule"]
    assert p.report.disagreeing and p.blocked


def _client_error(script):
    import sys
    err = sys.modules["botocore.exceptions"].ClientError()
    err.response = {"Error": {"Code": "InternalServerError", "Message": "boom"}}
    return err
