"""WHIT-445 — durable guards on the shared milestone-fakes modules.

WHIT-445 consolidated the milestone family's copy-pasted fakes into two modules:
  * _milestone_fakes.py     — the repo/notify class fakes + FACTS + the send_push recorder;
  * _milestone_row_fakes.py — the one good stored row (_GOOD) + _row + the raw-row injector.
A dozen suites now import them instead of each carrying its own copy that could drift (a
FakeNotifyRepo that drops the String-Set assert, a FakeMilestoneRepo that stops honouring
scope). These guards pin the refactor past today's grep:

  * [G1] no converted suite re-defines a shared fake locally (fail-on-revert for re-drift);
  * [G1b] each module still defines every name the suites import from it;
  * [G2] both modules stay dependency-light — importing them pulls no shared/-layer module,
         so they need no conftest `_REIMPORT` entry.
"""

import ast
import importlib
import pathlib

import pytest

_SHARED_TESTS = pathlib.Path(__file__).resolve().parent

_FAKES_MODULE = _SHARED_TESTS / "_milestone_fakes.py"
_ROW_FAKES_MODULE = _SHARED_TESTS / "_milestone_row_fakes.py"

# Names each module owns; if one is added there it should join this set too.
_FAKES_NAMES = frozenset({
    "FACTS", "_row", "FakeDeviceRepo", "FakeLoanFactsRepo", "FakeNotifyRepo",
    "FakeMilestoneRepo", "recorder",
})
_ROW_FAKES_NAMES = frozenset({"_GOOD", "_KEEP_MARKER", "_row", "_store_raw_row"})
_ALL_SHARED_NAMES = _FAKES_NAMES | _ROW_FAKES_NAMES

# The closed set of milestone suites converted to import the shared fakes. A future milestone
# suite that pastes a fake instead of importing should join this tuple (and be caught by [G1]).
_MILESTONE_SUITES = tuple(_SHARED_TESTS / name for name in (
    "test_milestones.py",
    "test_milestones_custom_plan.py",
    "test_milestone_rows.py",
))

_SHARED_LAYER = frozenset(
    p.stem for p in (_SHARED_TESTS.parents[1] / "shared").glob("*.py")
)


def _top_level_bindings(path: pathlib.Path) -> set:
    # The deduped view of the binding list — one AST walk, shared with the list version below.
    return set(_top_level_binding_list(path))


def _top_level_binding_list(path: pathlib.Path) -> list:
    """Every top-level def/class/assignment name AS A LIST (dups preserved). The set-returning
    _top_level_bindings above silently collapses a duplicate; this keeps it visible."""
    tree = ast.parse(path.read_text())
    names = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.append(node.name)
        elif isinstance(node, ast.Assign):
            names.extend(t.id for t in node.targets if isinstance(t, ast.Name))
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            names.append(node.target.id)
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


@pytest.mark.parametrize("module, expected", [
    (_FAKES_MODULE, _FAKES_NAMES),
    (_ROW_FAKES_MODULE, _ROW_FAKES_NAMES),
], ids=["_milestone_fakes", "_milestone_row_fakes"])
def test_module_defines_every_shared_name_exactly_here(module, expected):
    # [G1b] the ONE definition of each shared name really lives in its module.
    missing = sorted(expected - _top_level_bindings(module))
    assert not missing, (
        f"{module.name} no longer defines {missing}. If a fake moved out, the suites that "
        "import it break; if it was renamed, update the name set in this guard."
    )


@pytest.mark.parametrize("suite", _MILESTONE_SUITES, ids=lambda p: p.name)
def test_no_milestone_suite_re_defines_a_shared_fake(suite):
    # [G1] fail-on-revert for copy-paste drift: re-adding `class FakeNotifyRepo` (or any shared
    # fake / FACTS / _row / _GOOD) to a suite means two definitions again, and the copy can
    # drift from the real repositories while every test stays green. Nested subclasses
    # (RaisingNotifyRepo, CountingNotifyRepo) and local harness helpers (_notify, _run, _sweep)
    # are NOT shared names, so they don't trip this.
    redefined = sorted(_top_level_bindings(suite) & _ALL_SHARED_NAMES)
    assert not redefined, (
        f"{suite.name} re-defines shared milestone fakes {redefined} that live in "
        "_milestone_fakes.py / _milestone_row_fakes.py. Delete the local copy and import it — a "
        "second definition drifts and starts passing what the shared fake rejects (WHIT-445)."
    )


@pytest.mark.parametrize("suite", _MILESTONE_SUITES, ids=lambda p: p.name)
def test_no_milestone_suite_shadows_a_top_level_name(suite):
    # [G3] fail-on-revert for fold-drift (WHIT-471): folding N files into one can land two
    # top-level defs/consts with the SAME name (e.g. two `_run` helpers, two data consts). Python
    # keeps only the last; pytest still collects, and tests silently cross-bind to the survivor —
    # with NO linter in this repo to flag F811. [G1] deliberately ignores local helpers, so it
    # can't see this. A duplicate name here means a rename was missed in the fold: rename it.
    names = _top_level_binding_list(suite)
    dups = sorted({n for n in names if names.count(n) > 1})
    assert not dups, (
        f"{suite.name} defines these top-level names more than once: {dups}. A fold/merge left "
        "two same-named defs or consts; Python keeps only the last and tests silently bind the "
        "survivor. Rename the collision (per WHIT-471's _run_whit385 / _run_whit386 pattern)."
    )


@pytest.mark.parametrize("module_name, module_path", [
    ("_milestone_fakes", _FAKES_MODULE),
    ("_milestone_row_fakes", _ROW_FAKES_MODULE),
], ids=["_milestone_fakes", "_milestone_row_fakes"])
def test_milestone_fakes_import_without_pulling_the_shared_layer(module_name, module_path):
    # [G2] fail-on-revert for the dependency-light claim: the modules import only stdlib (+pytest
    # for the recorder fixture). A STATIC scan of their top-level imports catches a newly-added
    # shared/-layer import regardless of what a prior suite already loaded into sys.modules (a
    # runtime diff would miss an already-cached module). The static scan runs first (clear
    # message); then import it, to prove it loads.
    leaked = _top_level_import_bases(module_path) & _SHARED_LAYER
    assert not leaked, (
        f"{module_name} top-level-imports shared/-layer modules {sorted(leaked)}. Keep it "
        "dependency-light or add these names to tests/shared/conftest.py's _REIMPORT so they "
        "can't leak into sibling suites."
    )
    importlib.import_module(module_name)
