"""WHIT-466 — consolidated durable guards on the shared test-fakes modules.

WHIT-440 / WHIT-445 moved each domain's copy-pasted test fakes into ONE module under
tests/shared/ (``_feed_fakes``, ``_handler_patch_fakes``, ``_paycycle_fakes``,
``_category_fakes``, ``_milestone_fakes``, ``_milestone_row_fakes``) so their consuming
suites import them instead of carrying a copy that could drift. Those refactors each left a
near-identical guard file behind; WHIT-466 folds all five into this one registry-driven file,
losing no assertion. Every guard is fail-on-revert — re-copy a fake, or make one heavyweight,
and the matching case reddens:

  * [G1b] each fake module still defines every name its suites import from it;
  * [G1]  no consuming suite re-defines a shared fake locally (guards against copy re-drift);
  * [G2]  each fake module stays dependency-light — importing it pulls no shared/-layer module
          (static scan); and ``_category_fakes`` imports cleanly with botocore ABSENT (its error
          factories import ClientError lazily, so the import is collection-order safe);
  * [G3]  no milestone suite has two top-level defs/consts with the same name (fold-drift, WHIT-471).

Adding a new consuming suite? Register it in ``_REGISTRY`` below — the meta-guard
(``test_shared_fakes_tuple_completeness_gaps.py``) reddens with the filename to add if you forget.
"""

import ast
import importlib
import pathlib
import sys

import pytest

from _ast_bindings import _top_level_binding_list

_SHARED_TESTS = pathlib.Path(__file__).resolve().parent            # tests/shared
_API_TESTS = _SHARED_TESTS.parent / "lambda_api"                   # tests/lambda_api
# Bare names of the repo-root shared/ layer modules — a dependency-light fake must touch none.
_SHARED_LAYER = frozenset(
    p.stem for p in (_SHARED_TESTS.parents[1] / "shared").glob("*.py")
)


def _top_level_bindings(path: pathlib.Path) -> set:
    # The deduped view of the binding list — one AST walk, shared with the list form above.
    return set(_top_level_binding_list(path))


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


class _Module:
    """One shared fake module: the .py under tests/shared and the names it owns (checked by [G1b])."""

    def __init__(self, name: str, names):
        self.name = name
        self.path = _SHARED_TESTS / f"{name}.py"
        self.names = frozenset(names)


class _Domain:
    """A shared-fake family: its module(s), the suites that import them, and which guards apply."""

    def __init__(self, key, modules, suites, botocore_absent=False, shadow_check=False):
        self.key = key
        self.modules = modules            # list[_Module]
        self.suites = suites              # tuple[pathlib.Path]
        # Every fake module gets the static dependency-light scan ([G2-static]). A module whose
        # heavy import is deferred (category's in-function ClientError) ALSO gets the botocore-absent
        # import test ([G2-botocore]) — the one thing a static scan can't see.
        self.botocore_absent = botocore_absent
        self.shadow_check = shadow_check  # [G3] applies (fold-drift), milestone only

    @property
    def owned_names(self) -> frozenset:
        # A suite must not re-define ANY name the family owns; milestone spans two modules, so
        # [G1] checks a suite against the union (a suite may import from either module).
        return frozenset().union(*(module.names for module in self.modules))


_REGISTRY = [
    _Domain(
        "feed",
        [_Module("_feed_fakes",
                 {"ANZ", "SPENDING", "HOMELOAN", "_row", "FakeFeedRepo", "_feed_event"})],
        # WHIT-469 folded test_transactions_feed_gaps.py into the main.
        (_API_TESTS / "test_transactions_feed.py",),
    ),
    _Domain(
        "handler_patch",
        [_Module("_handler_patch_fakes", {"_UNSET", "FakeRepo", "_patch_event"})],
        # WHIT-469 folded test_handler_whit275_gaps.py / test_handler_whit296_gaps.py into the main.
        (_API_TESTS / "test_handler.py",),
    ),
    _Domain(
        "paycycle",
        [_Module("_paycycle_fakes", {"FakePayCycleRepo"})],
        (_API_TESTS / "test_paycycle.py", _API_TESTS / "test_paycycle_parity.py"),
    ),
    _Domain(
        "category",
        [_Module("_category_fakes", {
            "FakeTable", "FakeBudgetRepo", "_ccfe", "_validation_error", "_throttle",
            "_MAX_UPDATE_EXPRESSION_BYTES", "_CFG", "_SLOT", "_cat", "_categories_event",
            "_drain", "_piled_store", "_repo_with_fake_table", "_schema", "_slot_histogram",
        })],
        (_API_TESTS / "test_categories.py", _API_TESTS / "test_category_color_slots.py"),
        botocore_absent=True,
    ),
    _Domain(
        "milestone",
        [_Module("_milestone_fakes", {
            "FACTS", "_row", "FakeDeviceRepo", "FakeLoanFactsRepo", "FakeNotifyRepo",
            "FakeMilestoneRepo", "recorder",
         }),
         _Module("_milestone_row_fakes", {"_GOOD", "_KEEP_MARKER", "_row", "_store_raw_row"})],
        (_SHARED_TESTS / "test_milestones.py",
         _SHARED_TESTS / "test_milestones_custom_plan.py",
         _SHARED_TESTS / "test_milestone_rows.py"),
        shadow_check=True,
    ),
]

# A malformed registry (an empty suite tuple, or a domain that owns no names) would make the
# parametrized guards below collect ZERO cases and pass vacuously — silently voiding the
# fail-on-revert protection. Assert the registry is whole so that reddens loudly instead.
assert _REGISTRY, "fakes-invariants registry is empty"
for _domain in _REGISTRY:
    assert _domain.modules, f"{_domain.key} domain has no modules"
    assert _domain.suites, f"{_domain.key} domain has no suites"
    assert _domain.owned_names, f"{_domain.key} domain owns no names"


# Flat parameter lists built from the registry, so every case keeps its own "domain:name" id.
_MODULE_PARAMS = [
    pytest.param(module, id=f"{domain.key}:{module.name}")
    for domain in _REGISTRY for module in domain.modules
]
_SUITE_PARAMS = [
    pytest.param(domain.owned_names, suite, id=f"{domain.key}:{suite.name}")
    for domain in _REGISTRY for suite in domain.suites
]
# Every fake module gets the static dependency-light scan.
_STATIC_DEP_PARAMS = [
    pytest.param(module, id=f"{domain.key}:{module.name}")
    for domain in _REGISTRY for module in domain.modules
]
_BOTOCORE_ABSENT_PARAMS = [
    pytest.param(module, id=f"{domain.key}:{module.name}")
    for domain in _REGISTRY if domain.botocore_absent for module in domain.modules
]
_SHADOW_SUITE_PARAMS = [
    pytest.param(suite, id=f"{domain.key}:{suite.name}")
    for domain in _REGISTRY if domain.shadow_check for suite in domain.suites
]

# Same vacuous-pass defense as the registry asserts above: if a future edit left no module of a
# given kind, the matching guard would collect zero cases and silently skip. Fail loudly instead.
assert _STATIC_DEP_PARAMS, "no fake modules to guard ([G2-static])"
assert _BOTOCORE_ABSENT_PARAMS, "no botocore-absent modules to guard ([G2-botocore])"
assert _SHADOW_SUITE_PARAMS, "no shadow-checked suites to guard ([G3])"


@pytest.mark.parametrize("module", _MODULE_PARAMS)
def test_module_defines_every_shared_name(module):
    # [G1b] the ONE definition of each shared name really lives in its module.
    missing = sorted(module.names - _top_level_bindings(module.path))
    assert not missing, (
        f"{module.name}.py no longer defines {missing}. If a fake moved out, the suites that "
        "import it break; if it was renamed, update its name set in this file's registry."
    )


@pytest.mark.parametrize("owned_names, suite", _SUITE_PARAMS)
def test_no_suite_re_defines_a_shared_fake(owned_names, suite):
    # [G1] fail-on-revert for copy-paste drift: re-adding a shared fake (class or const) to a suite
    # means two definitions again, and the copy can drift from the real code while every test stays
    # green. Nested subclasses and local harness helpers are not shared names, so they don't trip it.
    redefined = sorted(_top_level_bindings(suite) & owned_names)
    assert not redefined, (
        f"{suite.name} re-defines shared fakes {redefined} that live in a tests/shared/_*_fakes.py "
        "module. Delete the local copy and import it — a second definition drifts and starts "
        "passing what the shared fake rejects (WHIT-440/445)."
    )


@pytest.mark.parametrize("module", _STATIC_DEP_PARAMS)
def test_fake_module_imports_without_pulling_the_shared_layer(module):
    # [G2] fail-on-revert for the dependency-light claim: a STATIC scan of top-level imports catches
    # a newly-added shared/-layer import regardless of what a prior suite already cached in
    # sys.modules (a runtime diff would miss an already-loaded module). The scan runs first (clear
    # message); then import it, to prove it loads.
    leaked = _top_level_import_bases(module.path) & _SHARED_LAYER
    assert not leaked, (
        f"{module.name} top-level-imports shared/-layer modules {sorted(leaked)}. Keep it "
        "dependency-light or add these names to tests/shared/conftest.py's _REIMPORT so they "
        "can't leak into sibling suites."
    )
    importlib.import_module(module.name)


@pytest.mark.parametrize("module", _BOTOCORE_ABSENT_PARAMS)
def test_fake_module_imports_without_botocore_installed(module):
    # [G2-botocore] fail-on-revert for the lazy-ClientError timing: a botocore_absent module (today
    # only _category_fakes) imports ClientError INSIDE its factories on purpose. If someone "tidies"
    # that to a module-top `from botocore.exceptions import ClientError`, importing it would need
    # botocore already faked — which only holds under some collection orders. The static scan above
    # can't see it (botocore isn't a shared/-layer module), so prove the import survives with botocore
    # removed from sys.modules entirely.
    keys = ("botocore", "botocore.exceptions", module.name)
    saved = {k: sys.modules.get(k) for k in keys}
    try:
        for k in keys:
            sys.modules.pop(k, None)
        assert "botocore" not in sys.modules  # precondition: really absent
        imported = importlib.import_module(module.name)  # must NOT raise ImportError
        assert module.names <= set(dir(imported))  # import produced the module with its owned names
    finally:
        for k, original in saved.items():
            if original is not None:
                sys.modules[k] = original
            else:
                sys.modules.pop(k, None)


@pytest.mark.parametrize("suite", _SHADOW_SUITE_PARAMS)
def test_no_suite_shadows_a_top_level_name(suite):
    # [G3] fail-on-revert for fold-drift (WHIT-471): folding N files into one can land two top-level
    # defs/consts with the SAME name (e.g. two `_run` helpers, two data consts). Python keeps only
    # the last; pytest still collects and tests silently cross-bind to the survivor, with no linter
    # here to flag F811. [G1] ignores local helpers, so it can't see this. A duplicate name means a
    # fold missed a rename.
    names = _top_level_binding_list(suite)
    dups = sorted({n for n in names if names.count(n) > 1})
    assert not dups, (
        f"{suite.name} defines these top-level names more than once: {dups}. A fold/merge left two "
        "same-named defs or consts; Python keeps only the last and tests silently bind the survivor. "
        "Rename the collision (per WHIT-471's _run_whit385 / _run_whit386 pattern)."
    )
