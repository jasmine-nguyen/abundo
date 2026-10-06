"""WHIT-755 slice 2 QA: the shared pay-cycle / category stand-ins and the suites that adopted them.

  * every alias over the shared pay-cycle fake is keyword-built and keeps its old defaults;
  * the spread suites' shared default taxonomy and the fail-on-purpose error behave like the copies;
  * no copy is left behind: guarded, under any name, by test_repo_fakes_by_behaviour.py (WHIT-766).
"""

import ast
import pathlib

import pytest

from _budget_endpoint_fakes import _FakeCategoryRepo, _FakePayCycleRepo, _SpendCategoryRepo, _spend_cat
from _feed_fakes import FakeCategoryRepo

_TESTS = pathlib.Path(__file__).resolve().parents[1]

# file → the (length, last_pay_date) its deleted pay-cycle copy defaulted to.
_OLD_PAY_CYCLE_DEFAULTS = {
    "lambda_api/test_budgets.py": (14, "2024-01-03"),
    "lambda_api/test_breakdown.py": (14, "2024-01-03"),
    "lambda_api/test_breakdown_lookback.py": (14, "2024-01-03"),
    "lambda_api/test_insights_ai.py": (14, "2024-01-03"),
    "lambda_api/test_shortfall_seam.py": (14, "2024-01-03"),
    "lambda_api/test_budgets_spread.py": (30, "2026-01-01"),
    "lambda_api/test_budgets_spread_gaps.py": (30, "2026-01-01"),
    "lambda_api/test_budgets_rollover.py": (30, "2026-01-01"),
    "lambda_api/test_budgets_rollover_gaps.py": (30, "2026-01-01"),
    "lambda_api/test_budgets_available.py": (30, "2026-01-01"),
    "lambda_api/test_budgets_available_gaps.py": (30, "2026-01-01"),
    "lambda_api/test_whit474_e2e_gaps.py": (30, "2026-01-01"),
}


def _module_constants(tree):
    constants = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    constants[target.id] = node.value.value
    return constants


def _partials_of(tree, fake_name):
    for node in ast.walk(tree):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "partial"
                and node.args and isinstance(node.args[0], ast.Name) and node.args[0].id == fake_name):
            yield node


def _resolve(value, constants):
    if isinstance(value, ast.Constant):
        return value.value
    return constants[value.id]


# [A1]
def test_every_pay_cycle_alias_is_built_with_keywords_so_call_sites_can_still_override():
    positional = []
    for path in _TESTS.rglob("test_*.py"):
        for call in _partials_of(ast.parse(path.read_text()), "_FakePayCycleRepo"):
            if len(call.args) > 1:
                positional.append(f"{path.relative_to(_TESTS)}:{call.lineno}")
    assert not positional, (
        "build partial(_FakePayCycleRepo, length=..., last_pay_date=...) with keywords, or a "
        "call site passing length= raises 'multiple values':\n" + "\n".join(positional))


# [A2]
@pytest.mark.parametrize("relative,expected", sorted(_OLD_PAY_CYCLE_DEFAULTS.items()))
def test_each_pay_cycle_alias_keeps_the_default_its_old_copy_had(relative, expected):
    tree = ast.parse((_TESTS / relative).read_text())
    constants = _module_constants(tree)
    calls = list(_partials_of(tree, "_FakePayCycleRepo"))
    assert len(calls) == 1, f"{relative}: expected one FakePayCycleRepo alias"
    keywords = {kw.arg: _resolve(kw.value, constants) for kw in calls[0].keywords}
    assert (keywords["length"], keywords["last_pay_date"]) == expected


# [A3]
def test_the_cycle_suites_using_the_bare_shared_fake_rely_on_its_30_day_july_default():
    assert _FakePayCycleRepo().get_paycycle() == {"length": 30, "last_pay_date": "2026-07-01"}
    for relative in ("lambda_api/test_cycle_budgets.py", "lambda_api/test_cycle_budgets_qa.py"):
        constants = _module_constants(ast.parse((_TESTS / relative).read_text()))
        assert (constants["LENGTH"], constants["PAYDATE"]) == (30, "2026-07-01"), relative


# [A4]
def test_the_spread_taxonomy_defaults_to_insurance_but_an_explicit_empty_list_stays_empty():
    assert _SpendCategoryRepo().list_categories() == [{"id": "insurance", "bucket": "Living", "parent": None}]
    assert _SpendCategoryRepo(None).list_categories() == _spend_cat()
    assert _SpendCategoryRepo([]).list_categories() == []
    rent = _SpendCategoryRepo(_spend_cat("rent", parent="home"))
    assert rent.list_categories() == [{"id": "rent", "bucket": "Living", "parent": "home"}]
    assert rent.list_calls == 1


# [A5]
@pytest.mark.parametrize("make", [
    lambda error: _FakeCategoryRepo([{"id": "groceries"}], error=error),
    lambda error: FakeCategoryRepo(["groceries"], error=error),
], ids=["dict-taxonomy", "id-taxonomy"])
def test_a_failing_taxonomy_fails_on_every_read_and_still_counts_it(make):
    boom = RuntimeError("taxonomy read boom")
    repo = make(boom)
    for _ in range(2):
        with pytest.raises(RuntimeError, match="taxonomy read boom"):
            repo.list_categories()
    assert repo.list_calls == 2


# [A6]
def test_without_an_error_the_category_fakes_serve_their_taxonomy():
    assert _FakeCategoryRepo([{"id": "groceries"}], error=None).list_categories() == [{"id": "groceries"}]
    assert FakeCategoryRepo(["groceries"], error=None).list_categories() == [{"id": "groceries"}]
