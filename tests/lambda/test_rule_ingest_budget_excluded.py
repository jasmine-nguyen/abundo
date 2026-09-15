"""WHIT-558: the webhook filer (rule_ingest.file_charge) also keeps a charge out of the budget when
the winning rule says so. Driven through the webhook `lam` fixture so rule_ingest, rule_engine and
banksync.counts_to_budget resolve as the deployed webhook resolves them.
"""


class _Store:
    def __init__(self, rules):
        self._rules = [dict(rule) for rule in rules]

    def list_rules(self):
        return [dict(rule) for rule in self._rules]


class _Cats:
    def __init__(self, ids):
        self._ids = list(ids)

    def list_categories(self):
        return [{"id": category_id} for category_id in self._ids]


def _rule(value, category_id="groceries", *, budget_excluded=False, rule_id=None):
    return {"id": rule_id or f"rule-{value}", "field": "description", "operator": "contains",
            "value": value, "category_id": category_id, "budget_excluded": budget_excluded}


def _charge(txn_id="t1", description="COLES 123 RICHMOND", category=None,
            account_id="up-spending"):
    return {"transaction_id": txn_id, "account_id": account_id, "description": description,
            "category": category, "counts_to_budget": True}


def test_sets_budget_excluded_when_the_winning_rule_excludes(lam):
    charge = _charge()
    lam.rule_ingest.apply([charge], rule_repo=_Store([_rule("COLES", budget_excluded=True)]),
                          category_repo=_Cats(["groceries"]))
    assert charge["category"] == "groceries"
    assert charge["budget_excluded"] is True


def test_leaves_the_flag_absent_when_the_rule_does_not_exclude(lam):
    # FAIL-ON-REVERT: setting charge["budget_excluded"] unconditionally would add False here,
    # breaking the sparse-storage convention (a cleared flag reads back ABSENT).
    charge = _charge()
    lam.rule_ingest.apply([charge], rule_repo=_Store([_rule("COLES", budget_excluded=False)]),
                          category_repo=_Cats(["groceries"]))
    assert charge["category"] == "groceries"
    assert "budget_excluded" not in charge


def test_does_not_exclude_when_matching_rules_disagree(lam):
    # Two rules match "COLES ONLINE" but file to different categories -> conflict, left unfiled.
    # The exclusion must not land on a charge no rule got to file.
    charge = _charge(description="COLES ONLINE")
    lam.rule_ingest.apply(
        [charge],
        rule_repo=_Store([_rule("COLES", "groceries", budget_excluded=True, rule_id="a"),
                          _rule("ONLINE", "coffee", budget_excluded=True, rule_id="b")]),
        category_repo=_Cats(["groceries", "coffee"]))
    assert charge["category"] is None
    assert "budget_excluded" not in charge
