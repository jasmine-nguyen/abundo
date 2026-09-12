"""delete-from-banksync tests for scripts/import_banksync_rules.py (WHIT-532).

These run through main() against the real RuleRepository, since delete mode's contract is about the
ORDER of writes (clear our row, THEN delete from BankSync) and its interaction with a re-run import.
"""

import pytest

T1, T2, T3 = "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z"


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


def test_app_repointed_flag_is_required(script):
    code = run(script, ["delete-from-banksync", "--apply"], payload())
    assert code == 2


def test_happy_path_clears_before_deleting(script):
    # Seed our store from BankSync, then delete. Instrument the order: every row-clear must land
    # before the first BankSync delete (reverse order could delete our own rule mid-run).
    response = payload(enr("e1", "WOOLWORTHS", "groceries"), enr("e3", "BP", "petrol"))
    run(script, ["import", "--apply"], response, now=T1)

    events = []
    real_stamp = script.repo.stamp_import

    def traced_stamp(rule_id, **kwargs):
        events.append(("clear", rule_id))
        return real_stamp(rule_id, **kwargs)
    script.repo.stamp_import = traced_stamp
    recorder = script.delete_recorder()

    def delete(enrichment_id):
        events.append(("delete", enrichment_id))
        recorder(enrichment_id)

    code = run(script, ["delete-from-banksync", "--apply", "--app-repointed"], response,
               delete=delete, now=T2)
    assert code == 0
    kinds = [kind for kind, _ in events]
    assert "delete" in kinds and kinds.index("clear") < kinds.index("delete")
    assert kinds.count("delete") == 2 and set(recorder.calls) == {"e1", "e3"}
    for row in script.repo.list_rules():
        assert "banksync_enrichment_ids" not in row       # every row cleared


def test_refusal_blocks_delete(script):
    # A category clash the app made -> import refuses -> delete does nothing.
    run(script, ["import", "--apply"], payload(enr("e1", "WOOLWORTHS", "groceries")), now=T1)
    script.repo.update_rule(rid(script, "WOOLWORTHS"), "description", "contains",
                            "WOOLWORTHS", "petrol")  # in-place category edit (touched)
    before = {k: dict(v) for k, v in script.table.store.items()}
    recorder = script.delete_recorder()
    code = run(script, ["delete-from-banksync", "--apply", "--app-repointed"],
               payload(enr("e1", "WOOLWORTHS", "groceries")), delete=recorder, now=T2)
    assert code == 1 and recorder.calls == []
    assert script.table.store == before                   # nothing written


def test_bucket_b_blocks_delete(script):
    recorder = script.delete_recorder()
    code = run(script, ["delete-from-banksync", "--apply", "--app-repointed"],
               payload(enr("e1", "WOOLWORTHS", "groceries"), enr("e8", "COLES", "nope")),
               delete=recorder, now=T1)
    assert code == 1 and recorder.calls == []


def test_banksync_holds_a_rule_we_never_imported(script):
    # Import can't create it (its category is unknown), and it isn't ledgered -> unaccounted.
    # Use an OK rule not present in our store or ledger, forced by making import a preview only.
    # Here: run delete with a fresh OK rule and no prior import write -> import creates it, so to
    # hit "unaccounted" we make the create fail, leaving it neither on a row nor ledgered.
    bad_id = rid(script, "WOOLWORTHS")

    def put(Item, ConditionExpression=None, _real=script.table.put_item):
        if Item.get("id") == bad_id:
            import sys
            err = sys.modules["botocore.exceptions"].ClientError()
            err.response = {"Error": {"Code": "InternalServerError", "Message": "boom"}}
            raise err
        return _real(Item, ConditionExpression=ConditionExpression)
    script.table.put_item = put
    recorder = script.delete_recorder()
    code = run(script, ["delete-from-banksync", "--apply", "--app-repointed"],
               payload(enr("e1", "WOOLWORTHS", "groceries")), delete=recorder, now=T1)
    assert code == 1 and recorder.calls == []


def test_interrupted_after_clear_is_recoverable(script):
    # The MAJOR-2 pin: delete dies AFTER clearing our row, BEFORE the BankSync delete lands.
    response = payload(enr("e1", "WOOLWORTHS", "groceries"))
    run(script, ["import", "--apply"], response, now=T1)

    boom = script.delete_recorder(fail_on=1, error=script.module.BankSyncError(500, "down"))
    code = run(script, ["delete-from-banksync", "--apply", "--app-repointed"], response,
               delete=boom, now=T2)
    assert code == 1
    row_id = rid(script, "WOOLWORTHS")
    assert "banksync_enrichment_ids" not in script.repo.get_rule(row_id)   # our row was cleared
    assert script.repo.get_import_ledger() == {"e1": row_id}               # id still in the ledger

    # Rerun import: e1 is in the ledger and on no row -> resolved, NOT re-created, NOT DeleteOurs.
    before = {k: dict(v) for k, v in script.table.store.items()}
    run(script, ["import", "--apply"], response, now=T3)
    assert script.table.store == before

    # Rerun delete with a healthy BankSync: the id is still deletable via ledger ∩ banksync.
    recorder = script.delete_recorder()
    code = run(script, ["delete-from-banksync", "--apply", "--app-repointed"], response,
               delete=recorder, now=T3)
    assert code == 0 and recorder.calls == ["e1"]


def test_id_on_two_rows_is_deleted_once(script):
    # The orphan shape update_rule can transiently leave (new row written, old delete failed): the
    # same BankSync id on two rows. Delete must clear both rows and DELETE the id exactly once.
    for value in ("WOOLWORTHS", "WOOLIES"):
        row_id = rid(script, value)
        row = {"pk": "RULE", "sk": f"RULE#{row_id}", "id": row_id,
               "field": "description", "operator": "contains",
               "value": value, "category_id": "groceries", "source": "import",
               "imported_at": T1, "updated_at": T1, "banksync_enrichment_ids": ["e1"]}
        script.repo._table.store[("RULE", f"RULE#{row_id}")] = row
    script.repo.add_to_import_ledger({"e1": rid(script, "WOOLWORTHS")}, stamp=T1)

    # BankSync still lists e1 (folding to WOOLWORTHS); the WOOLIES row is a stale twin.
    recorder = script.delete_recorder()
    code = run(script, ["delete-from-banksync", "--apply", "--app-repointed"],
               payload(enr("e1", "WOOLWORTHS", "groceries")), delete=recorder, now=T2)
    assert code == 0 and recorder.calls == ["e1"]         # deleted once
    for value in ("WOOLWORTHS", "WOOLIES"):
        assert "banksync_enrichment_ids" not in script.repo.get_rule(rid(script, value))


def test_post_cutover_rerun_is_a_no_op(script):
    # After a completed cutover, BankSync is empty and our rows carry no ids: both modes no-op.
    run(script, ["import", "--apply"], payload(enr("e1", "WOOLWORTHS", "groceries")), now=T1)
    recorder = script.delete_recorder()
    run(script, ["delete-from-banksync", "--apply", "--app-repointed"],
        payload(enr("e1", "WOOLWORTHS", "groceries")), delete=recorder, now=T2)

    before = {k: dict(v) for k, v in script.table.store.items()}
    empty = script.delete_recorder()
    code = run(script, ["delete-from-banksync", "--apply", "--app-repointed"], payload(),
               delete=empty, now=T3)
    assert code == 0 and empty.calls == []
    code = run(script, ["import", "--apply"], payload(), now=T3)
    assert code == 0 and script.table.store == before      # a rerun deletes nothing of ours


def test_clear_failure_holds_back_that_rows_banksync_delete(script):
    # Safety branch: if clearing OUR row fails, its BankSync id must NOT be deleted (deleting it
    # would strip the source of truth for a row we couldn't clear). Other rows still get deleted.
    response = payload(enr("e1", "WOOLWORTHS", "groceries"), enr("e3", "BP", "petrol"))
    run(script, ["import", "--apply"], response, now=T1)
    held_id = rid(script, "WOOLWORTHS")

    real_stamp = script.repo.stamp_import

    def stamp(rule_id, **kwargs):
        if rule_id == held_id:
            raise script.errors.VersionConflictError("changed under us")
        return real_stamp(rule_id, **kwargs)
    script.repo.stamp_import = stamp

    recorder = script.delete_recorder()
    code = run(script, ["delete-from-banksync", "--apply", "--app-repointed"], response,
               delete=recorder, now=T2)
    assert code == 1
    assert "e1" not in recorder.calls        # held back — its row could not be cleared
    assert "e3" in recorder.calls            # the row that cleared cleanly is still deleted


def test_import_write_failure_blocks_delete(script):
    # A failed category-stamp on a present row leaves our row stale; delete mode must NOT then
    # clear the row and delete its BankSync copy. The id is on the row, so `unaccounted` can't
    # catch it — the `report.failed` gate is what stops it.
    run(script, ["import", "--apply"], payload(enr("e1", "WOOLWORTHS", "groceries")), now=T1)
    # BankSync now recategorises e1; the untouched row gets an apply-category stamp during import.
    # Fail only THAT stamp (category_id set), delegating the delete-phase clears (category_id=None)
    # to the real repo — so reverting the report.failed gate lets the delete proceed and delete e1,
    # rather than being caught by the unrelated clear-failure hold-back branch.
    real_stamp = script.repo.stamp_import

    def stamp(rule_id, **kwargs):
        if kwargs.get("category_id") is not None:
            raise script.errors.DatabaseError("transient")
        return real_stamp(rule_id, **kwargs)
    script.repo.stamp_import = stamp

    recorder = script.delete_recorder()
    code = run(script, ["delete-from-banksync", "--apply", "--app-repointed"],
               payload(enr("e1", "WOOLWORTHS", "petrol")), delete=recorder, now=T2)
    assert code == 1 and recorder.calls == []     # nothing deleted from BankSync


def test_preview_delete_writes_nothing(script):
    run(script, ["import", "--apply"], payload(enr("e1", "WOOLWORTHS", "groceries")), now=T1)
    before = {k: dict(v) for k, v in script.table.store.items()}
    recorder = script.delete_recorder()
    code = run(script, ["delete-from-banksync"], payload(enr("e1", "WOOLWORTHS", "groceries")),
               delete=recorder, now=T2)
    assert code == 0 and recorder.calls == [] and script.table.store == before
