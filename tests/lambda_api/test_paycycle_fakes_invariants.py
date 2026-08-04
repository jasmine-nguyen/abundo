"""WHIT-445 — durable guards on the shared pay-cycle fake module.

WHIT-445 moved the handler-level FakePayCycleRepo into ONE module,
tests/shared/_paycycle_fakes.py, so the impl suite and the parity gap suite import it
instead of copying. Guards:

  * [G1] single definition, no copy re-drift — neither the impl suite nor the parity suite
         re-defines FakePayCycleRepo locally;
  * [G2] _paycycle_fakes stays dependency-light — importing it pulls NO shared/-layer module.

Scope note: the breakdown/budgets suites carry a differently-shaped FakePayCycleRepo
(`__init__(length=, last_pay_date=)`) that merely shares the name; it is a separate fake and
is intentionally NOT in _PAYCYCLE_SUITES.
"""

import ast
import importlib
import pathlib

import pytest

_TESTS = pathlib.Path(__file__).resolve().parent
_MODULE = _TESTS.parent / "shared" / "_paycycle_fakes.py"
_PAYCYCLE_SUITES = (
    _TESTS / "test_paycycle.py",
    _TESTS / "test_paycycle_parity.py",
)

_FAKE_NAMES = frozenset({"FakePayCycleRepo"})

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


def test_paycycle_fakes_module_defines_the_shared_fake_exactly_here():
    # [G1b] the ONE definition really lives in _paycycle_fakes.py.
    defined = _top_level_bindings(_MODULE)
    missing = sorted(_FAKE_NAMES - defined)
    assert not missing, (
        f"_paycycle_fakes.py no longer defines {missing}. If it moved, the suites that import "
        "it break; if it was renamed, update _FAKE_NAMES."
    )


@pytest.mark.parametrize("suite", _PAYCYCLE_SUITES, ids=lambda p: p.name)
def test_no_paycycle_suite_re_defines_the_shared_fake(suite):
    # [G1] fail-on-revert for copy-paste drift: re-adding `class FakePayCycleRepo` to either
    # suite means two definitions again, and the copy can drift from the real repo while every
    # test stays green.
    redefined = sorted(_top_level_bindings(suite) & _FAKE_NAMES)
    assert not redefined, (
        f"{suite.name} re-defines FakePayCycleRepo, which lives in "
        "tests/shared/_paycycle_fakes.py. Delete the local copy and import it (WHIT-445)."
    )


def test_paycycle_fakes_imports_without_pulling_the_shared_layer():
    # [G2] fail-on-revert for the dependency-light claim: the module is pure stdlib. A STATIC scan
    # of its top-level imports catches a newly-added shared/-layer import regardless of what a
    # prior suite already loaded into sys.modules (a runtime diff would miss an already-cached
    # module). The static scan runs first (clear message); then import it, to prove it loads.
    leaked = _top_level_import_bases(_MODULE) & _SHARED_LAYER
    assert not leaked, (
        f"_paycycle_fakes top-level-imports shared/-layer modules {sorted(leaked)}. Keep it "
        "dependency-light or add these names to tests/shared/conftest.py's _REIMPORT so they "
        "can't leak into sibling suites."
    )
    importlib.import_module("_paycycle_fakes")
