"""WHIT-445 — durable guards on the shared PATCH-handler fakes module.

WHIT-445 moved _UNSET / FakeRepo / _patch_event into ONE module,
tests/shared/_handler_patch_fakes.py, so the handler impl suite and its two PATCH gap
suites import them instead of copying. Two invariants keep the refactor safe past grep:

  * [G1] single definition, no copy re-drift — none of the three suites re-defines a shared
         fake locally (a copied FakeRepo could drift from the real sentinel-gated
         update_transaction_fields and start recording a field it no longer accepts);
  * [G2] _handler_patch_fakes stays dependency-light — importing it pulls NO shared/-layer
         module into sys.modules, so it needs no conftest `_REIMPORT` entry.
"""

import ast
import importlib
import pathlib

import pytest

_TESTS = pathlib.Path(__file__).resolve().parent
_MODULE = _TESTS.parent / "shared" / "_handler_patch_fakes.py"
# The closed set of PATCH-handler suites that import the shared fakes today. A future suite
# that pastes them instead of importing should join this tuple (and get caught by [G1]).
_HANDLER_SUITES = (
    _TESTS / "test_handler.py",
    _TESTS / "test_handler_whit275_gaps.py",
    _TESTS / "test_handler_whit296_gaps.py",
)

_FAKE_NAMES = frozenset({"_UNSET", "FakeRepo", "_patch_event"})

_SHARED_LAYER = frozenset(
    p.stem for p in (_TESTS.parents[1] / "shared").glob("*.py")
)


def _top_level_bindings(path: pathlib.Path) -> set:
    tree = ast.parse(path.read_text())
    names = set()
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.Assign):
            names.update(t.id for t in node.targets if isinstance(t, ast.Name))
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            names.add(node.target.id)  # annotated form, e.g. `_UNSET: object = object()`
    return names


def _top_level_import_bases(path: pathlib.Path) -> set:
    """Base module names of every ABSOLUTE top-level import — what actually gets pulled in at
    import time. Static, so it can't be fooled by a shared/-layer module a prior suite already
    loaded into sys.modules (which a runtime sys.modules diff would miss)."""
    tree = ast.parse(path.read_text())
    bases = set()
    for node in tree.body:
        if isinstance(node, ast.Import):
            bases.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            bases.add(node.module.split(".")[0])
    return bases


def test_handler_patch_fakes_module_defines_every_shared_fake_exactly_here():
    # [G1b] the ONE definition really lives in _handler_patch_fakes.py.
    defined = _top_level_bindings(_MODULE)
    missing = sorted(_FAKE_NAMES - defined)
    assert not missing, (
        f"_handler_patch_fakes.py no longer defines {missing}. If a fake moved out, the "
        "handler suites that import it break; if it was renamed, update _FAKE_NAMES."
    )


@pytest.mark.parametrize("suite", _HANDLER_SUITES, ids=lambda p: p.name)
def test_no_handler_suite_re_defines_a_shared_fake(suite):
    # [G1] fail-on-revert for copy-paste drift: re-adding `class FakeRepo` / `_patch_event`
    # to a suite means two definitions again, and the copy can drift from the real handler
    # while every test stays green. The grep, made durable.
    redefined = sorted(_top_level_bindings(suite) & _FAKE_NAMES)
    assert not redefined, (
        f"{suite.name} re-defines shared handler fakes {redefined} that live in "
        "tests/shared/_handler_patch_fakes.py. Delete the local copy and import it — a second "
        "definition drifts and starts passing what the shared fake rejects (WHIT-445)."
    )


def test_handler_patch_fakes_imports_without_pulling_the_shared_layer():
    # [G2] fail-on-revert for the dependency-light claim: the module is pure stdlib. A STATIC scan
    # of its top-level imports catches a newly-added shared/-layer import regardless of what a
    # prior suite already loaded into sys.modules (a runtime diff would miss an already-cached
    # module). The static scan runs first (clear message); then import it, to prove it loads.
    leaked = _top_level_import_bases(_MODULE) & _SHARED_LAYER
    assert not leaked, (
        f"_handler_patch_fakes top-level-imports shared/-layer modules {sorted(leaked)}. Keep it "
        "dependency-light (stdlib only) or add these names to tests/shared/conftest.py's "
        "_REIMPORT so they can't leak into sibling suites."
    )
    importlib.import_module("_handler_patch_fakes")
