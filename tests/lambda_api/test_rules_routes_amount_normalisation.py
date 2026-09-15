"""WHIT-564: an amount rule value is normalised to one canonical string (trailing zeros stripped,
never exponent form) BEFORE it becomes the stored value and the rule id, so 30 / 30.00 / 1e3 dedup
to one rule and row instead of minting duplicates. Covers BOTH write paths (the multi-condition path
and the flat single-condition path) and the flat<->multi collapse the fix preserves.

Driven through lambda_handler with a FakeRuleRepo injected, like test_rules_routes_multi_condition.py.
FakeRuleRepo keys rows by id exactly like the real store, so a dedup hit does not append to `minted`.
"""

import json

from _feed_fakes import FakeCategoryRepo, WritableFeedRepo
from _rule_fakes import FakeRuleRepo


_CATEGORIES = ("transport", "groceries")


def _event(method, path, body):
    return {"rawPath": path, "requestContext": {"http": {"method": method}},
            "body": json.dumps(body)}


def _inject(handler, monkeypatch, repo, categories=_CATEGORIES):
    monkeypatch.setattr(handler, "RuleRepository", lambda: repo)
    monkeypatch.setattr(handler, "CategoryRepository", lambda: FakeCategoryRepo(categories))
    monkeypatch.setattr(handler, "TransactionRepository", lambda: WritableFeedRepo({}))


def _post_multi(handler, amount_value, category_id="transport"):
    body = {"conditions": [{"field": "amount", "operator": "less_than", "value": amount_value}],
            "logic": "all", "categoryId": category_id}
    return handler.lambda_handler(_event("POST", "/rules", body), None)


def _post_flat(handler, amount_value, category_id="transport"):
    body = {"field": "amount", "operator": "less_than", "value": amount_value,
            "categoryId": category_id}
    return handler.lambda_handler(_event("POST", "/rules", body), None)


# --- multi-condition path: spellings of one amount dedup to one rule --------------------------


def test_multi_amount_spellings_dedup_to_one_rule(handler, monkeypatch):
    # The card: 30 / 30.0 / 30.00 / 30.000 are the same amount, so they must land on ONE row and id.
    # FAIL-ON-REVERT: drop the format(...,"f") normalisation and "30.00" keeps its trailing zeros ->
    # a different id -> a second row, so this reddens.
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)
    ids = set()
    for spelling in ["30", "30.0", "30.00", "30.000"]:
        resp = _post_multi(handler, spelling)
        assert resp["statusCode"] == 201
        ids.add(json.loads(resp["body"])["id"])
    assert len(ids) == 1                       # every spelling -> the same id
    assert len(repo.minted) == 1              # only the first actually wrote a row
    assert len(repo.list_rules()) == 1


def test_multi_amount_stores_the_canonical_value(handler, monkeypatch):
    # The normalisation reaches the stored row, not just the id: 30.00 is stored as "30".
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)
    out = json.loads(_post_multi(handler, "30.00")["body"])
    assert out["conditions"][0]["value"] == "30"
    assert repo.minted[0]["conditions"][0]["value"] == "30"


def test_multi_amount_exponent_input_canonicalises(handler, monkeypatch):
    # 1e3 and 1000 are the same amount -> one row. Guards that exponent-form INPUT is collapsed too.
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)
    first = json.loads(_post_multi(handler, "1e3")["body"])
    second = json.loads(_post_multi(handler, "1000")["body"])
    assert first["conditions"][0]["value"] == "1000"    # never "1E+3"
    assert first["id"] == second["id"]
    assert len(repo.minted) == 1


def test_multi_amount_canonical_value_is_never_exponent_form(handler, monkeypatch):
    # FAIL-ON-REVERT against a future simplification to str(amount.normalize()), which yields "1E+3"
    # for 1000 (match still passes, but fold lowercases it to "1e+3" -> a different id -> the bug is
    # back). The stored value must carry no exponent marker.
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)
    for spelling in ["1000", "100", "20", "1000000"]:
        value = json.loads(_post_multi(handler, spelling, category_id="groceries")["body"])["conditions"][0]["value"]
        assert "e" not in value.lower()


def test_multi_distinct_amounts_stay_distinct(handler, monkeypatch):
    # A genuinely different amount is a genuinely different rule: 30.5 must NOT collapse onto 30.
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)
    thirty = json.loads(_post_multi(handler, "30.00")["body"])
    thirty_five = json.loads(_post_multi(handler, "30.5")["body"])
    assert thirty["id"] != thirty_five["id"]
    assert len(repo.minted) == 2


# --- flat single-condition path: same normalisation (Option B) -------------------------------


def test_flat_amount_spellings_dedup_to_one_rule(handler, monkeypatch):
    # The flat/legacy body accepts an amount rule too; it must normalise identically so 30 and 30.00
    # typed the old way also dedup. FAIL-ON-REVERT: without routing the flat value through
    # _validate_condition_value, "30.00" is stored raw -> a second row.
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)
    first = json.loads(_post_flat(handler, "30.00")["body"])
    second = json.loads(_post_flat(handler, "30")["body"])
    assert first["value"] == "30"
    assert first["id"] == second["id"]
    assert len(repo.minted) == 1


def test_flat_amount_validates_like_the_multi_path(handler, monkeypatch):
    # Routing the flat value through the shared validator also closes the old gap where a flat amount
    # rule skipped numeric validation: a non-numeric / non-positive amount is now a 400, not a silently
    # stored no-op rule.
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)
    assert _post_flat(handler, "abc")["statusCode"] == 400
    assert _post_flat(handler, "0")["statusCode"] == 400
    assert repo.minted == []


def test_flat_and_multi_single_condition_amount_share_one_id(handler, monkeypatch):
    # THE collapse invariant Option B preserves: a one-condition amount rule built the multi way and
    # the same rule built the flat way are the SAME rule, so they must share an id and dedup. Before
    # the fix (multi normalised, flat raw) "30.00" would split into two ids across the two paths.
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)
    flat = json.loads(_post_flat(handler, "30.00")["body"])
    multi = json.loads(_post_multi(handler, "30.00")["body"])
    assert flat["id"] == multi["id"]
    assert len(repo.minted) == 1              # the multi POST deduped onto the flat row
