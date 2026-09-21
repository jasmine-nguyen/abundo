"""Shared AST helper for the consolidation / fakes guard suites (WHIT-473).

One copy of the top-level-binding walk that the duplicate-name guards use — [G3]
(test_fakes_invariants), [C1] (test_milestone_consolidation_invariants), and [G4]
(test_slice3b_consolidation_invariants). It was copy-pasted into all three, which risked
twin-drift — the exact failure those guards exist to catch — so it lives here once.
"""

import ast
import pathlib


def _top_level_binding_list(path: pathlib.Path) -> list:
    """Every top-level def/class/assignment name AS A LIST (dups preserved), so a duplicate-name
    guard can see a duplicate the set form would silently collapse. Covers the annotated form too,
    e.g. ``_UNSET: object = object()``."""
    tree = ast.parse(path.read_text())
    names: list = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.append(node.name)
        elif isinstance(node, ast.Assign):
            names.extend(t.id for t in node.targets if isinstance(t, ast.Name))
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            names.append(node.target.id)
    return names
