"""WHIT-473 — pin the DRY consolidation of the AST binding helper itself.

The three duplicate-name guards ([G3] test_fakes_invariants, [C1]
test_milestone_consolidation_invariants, [G4] test_slice3b_consolidation_invariants) now
share ONE ``_top_level_binding_list`` from ``tests/shared/_ast_bindings.py``. Nothing else
guards that single-source property — the guards scan other suites, not their own helper — so
a re-pasted local copy (the exact twin-drift these suites exist to catch) would slip through.
This automates the card's acceptance grep: exactly one ``def _top_level_binding_list``
across the test tree, and it lives in the shared module.
"""

import ast
import pathlib

_TESTS = pathlib.Path(__file__).resolve().parent.parent          # tests/
_SHARED_HELPER = _TESTS / "shared" / "_ast_bindings.py"


def _files_defining(name: str) -> list:
    hits = []
    for path in _TESTS.rglob("*.py"):
        tree = ast.parse(path.read_text())
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
                hits.append(path)
    return hits


def test_binding_helper_defined_in_exactly_one_place():
    # [S1] fail-on-revert for the consolidation: a re-duplicated local copy makes this list grow.
    hits = _files_defining("_top_level_binding_list")
    assert hits == [_SHARED_HELPER], (
        f"_top_level_binding_list must be defined once, in {_SHARED_HELPER.name}; "
        f"found in: {[str(p.relative_to(_TESTS)) for p in hits]}. A re-pasted local copy can "
        f"drift from its twin — the very failure the consolidation guards exist to catch."
    )
