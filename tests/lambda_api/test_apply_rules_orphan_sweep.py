"""WHIT-540 — the self-healing reconcile sweep inside "Apply my rules".

A rule edit/delete re-files the charges it touched immediately, but only up to its own write budget;
a rule on more history than that leaves a tail. The plain "Apply my rules" pass already reads every
charge, so while it's there it brings each rule-owned charge back in line with no client help:
  * stamp points at a rule that no longer exists -> undo the fill (delete / value-edit tail);
  * stamp points at a live rule but the charge is off that rule's target -> move it to the target
    (an in-place target-edit tail; also heals a settlement re-put, WHIT-513).

Only the PLAIN full sweep does this: the "file this shop" (inline-rule) path narrows the rule set
to the single minted rule, so it can't judge the store and must leave stamps alone.

The live rule's id comes from the FakeRuleRepo that derived it (the lambda_api suite can't import
rule_engine at collection time — see conftest); an orphan stamp is any id NOT in the store.
"""

import json

from _feed_fakes import SPENDING, _row, WritableFeedRepo, FakeCategoryRepo
from _rule_fakes import FakeRuleRepo


_CATEGORIES = frozenset({"groceries", "petrol"})


def _rule(value, category_id="groceries", field="description", operator="contains"):
    return {"field": field, "operator": operator, "value": value, "category_id": category_id}


def _apply(handler, repo, rule_repo, body, categories=_CATEGORIES):
    event = {"rawPath": "/transactions/uncategorized/apply-rules",
             "requestContext": {"http": {"method": "POST"}}, "body": json.dumps(body)}
    resp = handler.apply_rules_to_uncategorized(
        event, repo, FakeCategoryRepo(categories), rule_repo)
    return resp, json.loads(resp["body"])


def _row_at(repo, txn_id, account=SPENDING):
    return repo._find_row(f"ACCOUNT#{account}", f"TXN#{txn_id}")


def test_plain_sweep_undoes_charges_stamped_by_a_rule_that_no_longer_exists(handler):
    # "orphan" was filed to groceries by a rule since deleted (its stamp id isn't in the store).
    # A plain "Apply my rules" write clears it back to unfiled. FAIL-ON-REVERT: remove the sweep and
    # the orphan keeps its category and its dead stamp. "onTarget" is stamped by a LIVE rule and
    # already sits on that rule's target, so it is left untouched (no drift).
    rule_repo = FakeRuleRepo(rules=[_rule("coles", "groceries")])
    live = rule_repo.list_rules()[0]["id"]
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-02", "orphan", description="OLD SHOP",
             category="groceries", filed_by_rule="dead-rule"),
        _row(SPENDING, "2026-07-01", "onTarget", description="COLES",
             category="groceries", filed_by_rule=live),
    ]})

    _apply(handler, repo, rule_repo, {"dryRun": False})

    orphan = _row_at(repo, "orphan")
    assert "category" not in orphan and "filed_by_rule" not in orphan   # undone
    kept = _row_at(repo, "onTarget")
    assert kept["category"] == "groceries" and kept["filed_by_rule"] == live  # on target -> left alone
    assert repo.writes == [(f"ACCOUNT#{SPENDING}", "TXN#orphan", "clear", "dead-rule")]  # only the orphan


def test_plain_sweep_refiles_a_live_rules_drifted_tail(handler):
    # THE F1 HEAL. "drift" is owned by a live rule (coles -> petrol now) but still sits on the OLD
    # target (groceries) — the tail of an in-place target edit that exceeded the write budget. The
    # sweep moves it to the rule's CURRENT target without re-evaluating (the stamp already names the
    # rule). FAIL-ON-REVERT: keep only the orphan branch (skip live-rule stamps) and the tail is
    # stranded on groceries forever.
    rule_repo = FakeRuleRepo(rules=[_rule("coles", "petrol")])
    live = rule_repo.list_rules()[0]["id"]
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-01", "drift", description="COLES",
             category="groceries", filed_by_rule=live),
    ]})

    _apply(handler, repo, rule_repo, {"dryRun": False})

    row = _row_at(repo, "drift")
    assert row["category"] == "petrol"          # moved to the rule's current target
    assert row["filed_by_rule"] == live         # still owned by the same rule


def test_plain_sweep_leaves_unstamped_charges_alone(handler):
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-02", "plain", description="CAFE", category="petrol"),  # no stamp
    ]})

    _apply(handler, repo, FakeRuleRepo(rules=[_rule("coles", "groceries")]), {"dryRun": False})

    assert _row_at(repo, "plain")["category"] == "petrol"


def test_dry_run_never_sweeps(handler):
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-02", "orphan", description="OLD", category="groceries",
             filed_by_rule="dead-rule"),
    ]})

    _, body = _apply(handler, repo, FakeRuleRepo(rules=[_rule("coles", "groceries")]),
                     {"dryRun": True})

    assert body["dryRun"] is True
    assert _row_at(repo, "orphan")["category"] == "groceries"   # preview writes nothing
    assert repo.writes == []


def test_file_this_shop_path_does_not_sweep_orphans(handler):
    # The inline "file this shop" path narrows the rule set to the one minted rule, so it cannot
    # judge which stamps are orphaned — it must leave them. FAIL-ON-REVERT: run the sweep in the
    # inline path too and this orphan is wrongly undone during an unrelated "file WOOLIES".
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-02", "orphan", description="OLD", category="groceries",
             filed_by_rule="dead-rule"),
        _row(SPENDING, "2026-07-01", "target", description="WOOLIES", category=None),
    ]})

    _apply(handler, repo, FakeRuleRepo(), {"dryRun": False,
           "rule": {"value": "woolies", "categoryId": "groceries"}})

    assert _row_at(repo, "orphan")["category"] == "groceries"    # left alone
    assert _row_at(repo, "orphan")["filed_by_rule"] == "dead-rule"
    assert _row_at(repo, "target")["category"] == "groceries"    # the shop WAS filed
