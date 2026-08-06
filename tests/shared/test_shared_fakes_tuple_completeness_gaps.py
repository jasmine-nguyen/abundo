"""WHIT-445 gap coverage — keep each invariants guard's CLOSED suite tuple complete.

The consolidated invariants guard (``test_fakes_invariants.py``) iterates a HARD-CODED registry
of suites per domain (feed / handler_patch / paycycle / category / milestone) when proving "no
suite re-defines the shared fake" ([G1]). That is a closed list: a NEW suite added later that
IMPORTS the shared fake but is never added to the registry is invisible to [G1] — it could later
paste a divergent copy of the fake and stay green forever.

This meta-guard closes that hole without the false-positives a tree-wide "single definition"
scan would hit (FakeNotifyRepo / FakeMilestoneRepo / FakePayCycleRepo are legitimately
re-defined, with DIFFERENT shapes, by unrelated domains — milestone-review API, budget-alerts
Lambda, the e2e suites). It asserts the far narrower, false-positive-free property: every suite
that actually IMPORTS a shared fake module is listed in that module's guard tuple.

Fail-on-revert: add a new `tests/shared/test_milestones_whitNNN_gaps.py` that
`from _milestone_fakes import ...` without adding it to _MILESTONE_SUITES → this reddens with the
exact filename to add, BEFORE that suite can quietly grow a drifting copy.
"""

import ast
import pathlib

import pytest

_TESTS = pathlib.Path(__file__).resolve().parent.parent          # tests/
_SHARED = _TESTS / "shared"
_API = _TESTS / "lambda_api"

# The WHIT-445 guards/meta-tests import the fake MODULES to introspect them, not to use them as
# test doubles, so they are not "suites that could paste a drifting copy". They are excluded
# rather than added to every domain tuple. Any OTHER new importer is a real consuming suite and
# must be registered — that is the property under test.
_GUARD_FILES = frozenset({
    "test_fakes_invariants.py",
    "test_shared_fakes_contract_gaps.py",
    "test_shared_fakes_tuple_completeness_gaps.py",
})


def _string_constants(path: pathlib.Path) -> set:
    """Every str literal anywhere in the file — enough to read the *.py names out of a guard
    tuple however it's spelled (plain tuple or a `tuple(... for name in (...))` comprehension)."""
    tree = ast.parse(path.read_text())
    return {n.value for n in ast.walk(tree)
            if isinstance(n, ast.Constant) and isinstance(n.value, str)}


def _declared_suite_names(guard: pathlib.Path) -> set:
    """The test_*.py basenames the guard's closed tuple enumerates."""
    return {s for s in _string_constants(guard)
            if s.startswith("test_") and s.endswith(".py")}


def _importers(search_dir: pathlib.Path, modules) -> set:
    """Basenames of suites under search_dir with a top-level `from <module> import ...`."""
    found = set()
    for path in search_dir.glob("test_*.py"):
        if path.name in _GUARD_FILES:
            continue
        tree = ast.parse(path.read_text())
        for node in tree.body:
            if isinstance(node, ast.ImportFrom) and node.module in modules:
                found.add(path.name)
    return found


# WHIT-466 folded the five per-domain invariants files into this one; its registry lists every
# domain's suites, so all domains point at it. category joins now that it lives there too.
_CONSOLIDATED_GUARD = _SHARED / "test_fakes_invariants.py"

# (search dir, imported shared modules, the guard file whose registry must cover the importers)
_DOMAINS = [
    pytest.param(_SHARED, {"_milestone_fakes", "_milestone_row_fakes"},
                 _CONSOLIDATED_GUARD, id="milestone"),
    pytest.param(_API, {"_feed_fakes"}, _CONSOLIDATED_GUARD, id="feed"),
    pytest.param(_API, {"_handler_patch_fakes"}, _CONSOLIDATED_GUARD, id="handler_patch"),
    pytest.param(_API, {"_paycycle_fakes"}, _CONSOLIDATED_GUARD, id="paycycle"),
    pytest.param(_API, {"_category_fakes"}, _CONSOLIDATED_GUARD, id="category"),
]


@pytest.mark.parametrize("search_dir, modules, guard", _DOMAINS)
def test_every_importer_is_covered_by_the_guard_tuple(search_dir, modules, guard):
    importers = _importers(search_dir, modules)
    assert importers, f"no suite imports {sorted(modules)} — the refactor or this test moved"
    declared = _declared_suite_names(guard)
    uncovered = sorted(importers - declared)
    assert not uncovered, (
        f"{sorted(modules)} is imported by {uncovered}, which the closed tuple in {guard.name} "
        "does NOT list — so its [G1] no-redefinition guard skips them. Add them to that tuple "
        "(WHIT-445), else a new suite could paste a drifting copy of the fake and stay green."
    )
