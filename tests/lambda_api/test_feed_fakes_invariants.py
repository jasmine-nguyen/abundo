"""WHIT-445 — durable guards on the shared feed-fakes module.

WHIT-445 moved FakeFeedRepo (+ _row / _feed_event / the account-id constants) into ONE
module, tests/shared/_feed_fakes.py, so the feed impl suite and its gap suite import them
instead of copying. Two invariants keep the refactor safe past today's grep:

  * [G1] single definition, no copy re-drift — neither feed suite re-defines a shared fake
         locally (a copied FakeFeedRepo would drift and start passing what the real
         resume-strictly-after feed rejects);
  * [G2] _feed_fakes stays dependency-light — importing it pulls NO shared/-layer module
         into sys.modules, so it needs no conftest `_REIMPORT` entry and can be imported
         from any suite without the `handler`/`shared` fixture first putting shared/ on path.
"""

import ast
import importlib
import pathlib

import pytest

_TESTS = pathlib.Path(__file__).resolve().parent
_MODULE = _TESTS.parent / "shared" / "_feed_fakes.py"
# The closed set of feed suites that import the shared fake today. A future third feed suite
# that pastes the fake instead of importing should join this tuple (and get caught by [G1]).
_FEED_SUITES = (
    _TESTS / "test_transactions_feed.py",
    _TESTS / "test_transactions_feed_gaps.py",
)

# Every name _feed_fakes centralises. A suite that re-defines any of them has re-introduced
# the copy-paste drift the refactor killed.
_FAKE_NAMES = frozenset({
    "ANZ", "SPENDING", "HOMELOAN", "_row", "FakeFeedRepo", "_feed_event",
})

# Bare names of the repo-root shared/ layer modules — importing _feed_fakes must touch none.
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


def test_feed_fakes_module_defines_every_shared_fake_exactly_here():
    # [G1b] the ONE definition really lives in _feed_fakes.py.
    defined = _top_level_bindings(_MODULE)
    missing = sorted(_FAKE_NAMES - defined)
    assert not missing, (
        f"_feed_fakes.py no longer defines {missing}. If a fake moved out, the feed suites "
        "that import it break; if it was renamed, update _FAKE_NAMES."
    )


@pytest.mark.parametrize("suite", _FEED_SUITES, ids=lambda p: p.name)
def test_no_feed_suite_re_defines_a_shared_fake(suite):
    # [G1] fail-on-revert for copy-paste drift: re-adding `class FakeFeedRepo` (or _row /
    # _feed_event / a constant) to a suite means two definitions again, and the copy can drift
    # away from the real feed while every test stays green. The grep, made durable.
    redefined = sorted(_top_level_bindings(suite) & _FAKE_NAMES)
    assert not redefined, (
        f"{suite.name} re-defines shared feed fakes {redefined} that live in "
        "tests/shared/_feed_fakes.py. Delete the local copy and import it — a second "
        "definition drifts and starts passing what the shared fake rejects (WHIT-445)."
    )


def test_feed_fakes_imports_without_pulling_the_shared_layer():
    # [G2] fail-on-revert for the dependency-light claim: _feed_fakes uses only stdlib `copy`. If
    # someone adds a module-top `import repository` (or any shared/-layer import) the module would
    # need shared/ on sys.path already and a conftest `_REIMPORT` entry to avoid leaking into
    # sibling suites. A STATIC scan of its top-level imports catches that regardless of what a
    # prior suite already loaded into sys.modules (a runtime diff would miss an already-cached
    # module). The static scan runs first (clear message); then import it, to prove it loads.
    leaked = _top_level_import_bases(_MODULE) & _SHARED_LAYER
    assert not leaked, (
        f"_feed_fakes top-level-imports shared/-layer modules {sorted(leaked)}. Keep it "
        "dependency-light (stdlib only) or add these names to tests/shared/conftest.py's "
        "_REIMPORT so they can't leak into sibling suites."
    )
    importlib.import_module("_feed_fakes")
