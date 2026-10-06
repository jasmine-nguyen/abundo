"""update_expression (shared/repository_base.py, WHIT-790): the one shared builder for a database
'set these fields, clear those' instruction, with its attribute aliases."""

import re

import pytest

_CASES = [
    (
        "sets only",
        {"category": "shopping", "notes": None},
        (),
        ("SET #f0 = :v0, #f1 = :v1", {"#f0": "category", "#f1": "notes"}, {":v0": "shopping", ":v1": None}),
    ),
    (
        "removes only",
        {},
        ["filed_by_rule"],
        ("REMOVE #f0", {"#f0": "filed_by_rule"}, {}),
    ),
    (
        "sets and removes",
        {"category": "shopping"},
        ["filed_by_rule", "notes"],
        (
            "SET #f0 = :v0 REMOVE #f1, #f2",
            {"#f0": "category", "#f1": "filed_by_rule", "#f2": "notes"},
            {":v0": "shopping"},
        ),
    ),
    ("nothing", {}, (), ("", {}, {})),
]


@pytest.mark.parametrize("sets, removes, expected", [case[1:] for case in _CASES], ids=[case[0] for case in _CASES])
def test_update_expression_builds_the_instruction_and_declares_only_the_aliases_it_uses(
    shared, sets, removes, expected
):
    import repository_base

    expression, names, values = repository_base.update_expression(sets, removes)

    assert (expression, names, values) == expected
    used = set(re.findall(r"[#:]\w+", expression))
    assert used == set(names) | set(values)
