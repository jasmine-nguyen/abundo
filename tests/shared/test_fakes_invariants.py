"""Durable guards on the shared test-fake modules, found from the folder (WHIT-466, WHIT-625).

No list to keep up to date: every ``tests/shared/_*_fakes.py`` and every milestone suite is picked
up by glob, so adding a test file or a fake module needs no entry here.

  * [G2] each fake module stays dependency-light — its top-level imports pull in no shared/-layer
         module (static scan), and it imports cleanly with botocore ABSENT (error factories resolve
         ClientError lazily, so the import is collection-order safe);
  * [G3] no milestone suite has two top-level defs/consts with the same name (fold-drift, WHIT-471).
"""

import ast
import importlib
import pathlib
import sys

import pytest

from _ast_bindings import _top_level_binding_list

_SHARED_TESTS = pathlib.Path(__file__).resolve().parent            # tests/shared
# Bare names of the repo-root shared/ layer modules — a dependency-light fake must touch none.
_SHARED_LAYER = frozenset(
    p.stem for p in (_SHARED_TESTS.parents[1] / "shared").glob("*.py")
)

_FAKE_MODULES = [pytest.param(path, id=path.stem) for path in sorted(_SHARED_TESTS.glob("_*_fakes.py"))]
# Loads a real scripts/ migration at import, which needs the real botocore — not a fake to keep light.
_LOADS_A_SCRIPT = {"_migration_spread_fakes"}
_MILESTONE_SUITES = [
    pytest.param(path, id=path.stem) for path in sorted(_SHARED_TESTS.glob("test_milestone*.py"))
]

# A glob that matched nothing would collect zero cases and pass vacuously. Fail loudly instead.
assert _FAKE_MODULES, "no tests/shared/_*_fakes.py modules found"
assert _MILESTONE_SUITES, "no tests/shared/test_milestone*.py suites found"


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


@pytest.mark.parametrize("path", _FAKE_MODULES)
def test_fake_module_imports_without_pulling_the_shared_layer(path):
    # [G2] a STATIC scan of top-level imports catches a newly-added shared/-layer import regardless
    # of what a prior suite already cached in sys.modules. Then import it, to prove it loads.
    leaked = _top_level_import_bases(path) & _SHARED_LAYER
    assert not leaked, (
        f"{path.stem} top-level-imports shared/-layer modules {sorted(leaked)}. Keep it "
        "dependency-light: import the shared layer lazily, inside the helper that needs it."
    )
    importlib.import_module(path.stem)


@pytest.mark.parametrize("path", _FAKE_MODULES)
def test_fake_module_imports_without_botocore_installed(path):
    # [G2-botocore] a module-top `from botocore.exceptions import ClientError` would need botocore
    # already faked — which only holds under some collection orders. The static scan can't see it
    # (botocore isn't a shared/-layer module), so prove the import survives with botocore removed.
    # _dynamo_fakes goes too, since most fake modules import it.
    if path.stem in _LOADS_A_SCRIPT:
        pytest.skip("loads a scripts/ migration, which imports the real botocore")
    keys = ("botocore", "botocore.exceptions", "_dynamo_fakes", path.stem)
    saved = {k: sys.modules.get(k) for k in keys}
    try:
        for k in keys:
            sys.modules.pop(k, None)
        assert "botocore" not in sys.modules  # precondition: really absent
        importlib.import_module(path.stem)    # must NOT raise ImportError
    finally:
        for k, original in saved.items():
            if original is not None:
                sys.modules[k] = original
            else:
                sys.modules.pop(k, None)


@pytest.mark.parametrize("path", _MILESTONE_SUITES)
def test_no_suite_shadows_a_top_level_name(path):
    # [G3] fold-drift (WHIT-471): folding N files into one can land two top-level defs/consts with
    # the SAME name. Python keeps only the last and tests silently cross-bind to the survivor.
    names = _top_level_binding_list(path)
    dups = sorted({n for n in names if names.count(n) > 1})
    assert not dups, (
        f"{path.name} defines these top-level names more than once: {dups}. A fold/merge left two "
        "same-named defs or consts; Python keeps only the last and tests silently bind the survivor. "
        "Rename the collision (per WHIT-471's _run_whit385 / _run_whit386 pattern)."
    )
