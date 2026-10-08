"""WHIT-766 QA: the behaviour-based guard."""

import pytest

from test_repo_fakes_by_behaviour import _is_shared_fake_module, _local_copies


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
