"""WHIT-766 QA: the behaviour-based guard, and the renamed copies' aliases keep their old data."""

import ast
import pathlib

import pytest

from test_repo_fakes_by_behaviour import _is_shared_fake_module, _local_copies
from test_repo_fakes_shared_qa import _module_constants, _partials_of, _resolve

_TESTS = pathlib.Path(__file__).resolve().parents[1]


# [A1]
def test_the_guard_flags_a_top_level_category_copy_but_not_a_subclass_or_an_unrelated_class():
    source = (
        "class _Cats:\n"
        "    def __init__(self):\n"
        "        pass\n"
        "    def list_categories(self):\n"
        "        return []\n"
        "class _Extended(FakeCategoryRepo):\n"
        "    def list_categories(self):\n"
        "        return []\n"
        "class _Store:\n"
        "    def list_rules(self):\n"
        "        return []\n"
    )
    assert _local_copies(source) == [(1, "_Cats")]


# [A2]
@pytest.mark.parametrize("relative,exempt", [
    ("shared/_feed_fakes.py", True),
    ("shared/_budget_endpoint_fakes.py", True),
    ("shared/test_feed_fakes.py", False),
    ("shared/_terraform.py", False),
    ("lambda/_local_fakes.py", False),
    ("shared/_old/copied_fakes.py", False),
    ("lambda_api/test_ai_chat.py", False),
])
def test_only_the_shared_fake_modules_are_exempt_from_the_guard(relative, exempt):
    assert _is_shared_fake_module(relative) is exempt


# [A3]
@pytest.mark.parametrize("relative", [
    "lambda_api/test_apply_rules_spread.py",
    "lambda_api/test_apply_rules_spread_gaps.py",
    "lambda_api/test_rule_reply_shape_gaps.py",
    "shared/test_rule_spreading.py",
])
def test_each_spread_pay_cycle_alias_keeps_its_old_copy_default(relative):
    tree = ast.parse((_TESTS / relative).read_text())
    constants = _module_constants(tree)
    calls = list(_partials_of(tree, "_FakePayCycleRepo"))
    assert len(calls) == 1, f"{relative}: expected one _FakePayCycleRepo alias"
    keywords = {kw.arg: _resolve(kw.value, constants) for kw in calls[0].keywords}
    assert (keywords["length"], keywords["last_pay_date"]) == (14, "2026-01-07")


# [A4]
@pytest.mark.parametrize("relative,ids", [
    ("lambda/test_reprocess_book_qa.py", ["groceries"]),
    ("lambda/test_rule_ingest_book_only.py", ["groceries", "petrol"]),
    ("lambda/test_rule_ingest_file_charge_qa.py", ["groceries", "petrol"]),
])
def test_each_cats_alias_keeps_the_taxonomy_its_old_copy_served(relative, ids):
    calls = list(_partials_of(ast.parse((_TESTS / relative).read_text()), "FakeCategoryRepo"))
    assert len(calls) == 1, f"{relative}: expected one FakeCategoryRepo alias"
    keywords = {kw.arg: ast.literal_eval(kw.value) for kw in calls[0].keywords}
    assert keywords == {"category_ids": ids}
