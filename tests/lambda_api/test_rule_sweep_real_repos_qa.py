"""WHIT-625 slice 2 QA — the sweep's "compare against what the scan saw" branch, on the real code.

The migrated suites race a tap against a charge the scan saw as UNFILED (no category), which only
exercises the `attribute_not_exists(#c)` half of the real conditional write. A charge the scan saw
with the bank's raw label takes the other half (`#c = :expected`). These drive that half through
the handler over the real repositories, so a loosened comparison can't hide behind a fake.
"""

import json

from _api_event import api_event
from _feed_fakes import SPENDING, FakeCategoryRepo, _row, on_write, real_repos, set_category, stored
from _rule_ingest_fakes import apply_rules_to_uncategorized


def _sweep(handler, repo, rule_repo):
    resp = apply_rules_to_uncategorized(
        handler,
        api_event("POST", "/transactions/uncategorized/apply-rules", body={"dryRun": False}),
        repo, FakeCategoryRepo(("groceries", "coffee")), rule_repo)
    return resp, json.loads(resp["body"])


def _raw_labelled_coles():
    return real_repos(
        {SPENDING: [
            _row(SPENDING, "2026-07-02", "t1", description="COLES 1"),
            _row(SPENDING, "2026-07-01", "t2", description="COLES 2", category="FOOD_AND_DRINK"),
        ]},
        rules=[{"field": "description", "operator": "contains", "value": "coles",
                "category_id": "groceries"}],
    )


def test_a_tap_on_a_raw_labelled_charge_mid_run_wins(handler):
    # [A1] The scan saw t2 with the bank's label; the user taps "coffee" before the write lands.
    # The real condition (#c = :expected) must refuse the rule's write.
    table, repo, rule_repo = _raw_labelled_coles()
    on_write(table, "t1", lambda tbl: set_category(tbl, "t2", "coffee"))

    resp, body = _sweep(handler, repo, rule_repo)

    assert resp["statusCode"] == 200
    assert body["filed"] == [{"id": "t1", "category": "groceries"}]
    assert body["alreadyFiled"] == ["t2"]
    assert stored(table, "t2")["category"] == "coffee"
    assert "filed_by_rule" not in stored(table, "t2")


def test_a_raw_label_that_changed_to_another_raw_label_is_not_overwritten(handler):
    # [A2] A re-sync swaps t2's label mid-run. Still unfiled, so it is reported as failed (retry),
    # and the rule's write must NOT land over the label the scan never saw.
    table, repo, rule_repo = _raw_labelled_coles()
    on_write(table, "t1", lambda tbl: set_category(tbl, "t2", "TRANSFER_OUT"))

    _, body = _sweep(handler, repo, rule_repo)

    assert body["failed"] == ["t2"]
    assert stored(table, "t2")["category"] == "TRANSFER_OUT"
    assert "filed_by_rule" not in stored(table, "t2")


def test_an_untouched_raw_labelled_charge_is_filed_and_stamped(handler):
    # [A3] Control for [A1]/[A2]: with no tap, the same branch writes and stamps the real rule id.
    table, repo, rule_repo = _raw_labelled_coles()
    [rule] = rule_repo.list_rules()

    _, body = _sweep(handler, repo, rule_repo)

    assert {entry["id"] for entry in body["filed"]} == {"t1", "t2"}
    assert stored(table, "t2")["category"] == "groceries"
    assert stored(table, "t2")["filed_by_rule"] == rule["id"]
