"""WHIT-440 — durable guards on the shared category-fakes module.

WHIT-440 moved 15 fakes into ONE module (tests/shared/_category_fakes.py) so the three
category suites import them instead of copying or re-exec'ing the impl suite. Two invariants
made the refactor safe but rest on human grep today; these tests pin them so a future edit
that SILENTLY WEAKENS the suite (rather than breaking it loudly) reddens instead:

  * [G1] single definition, no copy re-drift — no suite re-defines a fake locally
         (a copy of FakeTable would drift and start passing what the real 4KB guard rejects);
  * [G2] _category_fakes imports cleanly with botocore ABSENT — ClientError is imported
         lazily inside the factories, NOT at module top, so importing the module never
         depends on a suite's boto fake already being installed (collection-order safe).
"""

import ast
import importlib
import pathlib
import sys

import pytest

_TESTS = pathlib.Path(__file__).resolve().parent
_MODULE = _TESTS.parent / "shared" / "_category_fakes.py"
_CATEGORY_SUITES = (
    _TESTS / "test_categories.py",
    _TESTS / "test_categories_whit428_gaps.py",
    _TESTS / "test_categories_whit428_round2.py",
)

# Every fake WHIT-440 centralised. If a name is added to _category_fakes it should join this
# list too; a suite that re-defines any of them has re-introduced the drift the refactor killed.
_FAKE_NAMES = frozenset({
    "FakeTable", "FakeBudgetRepo", "_ccfe", "_validation_error", "_throttle",
    "_MAX_UPDATE_EXPRESSION_BYTES", "_CFG", "_SLOT", "_cat", "_categories_event",
    "_drain", "_piled_store", "_repo_with_fake_table", "_schema", "_slot_histogram",
})


def _top_level_bindings(path: pathlib.Path) -> set:
    tree = ast.parse(path.read_text())
    names = set()
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.Assign):
            names.update(t.id for t in node.targets if isinstance(t, ast.Name))
    return names


def test_category_fakes_module_defines_every_shared_fake_exactly_here():
    # [G1b] the ONE definition really lives in _category_fakes.py.
    defined = _top_level_bindings(_MODULE)
    missing = sorted(_FAKE_NAMES - defined)
    assert not missing, (
        f"_category_fakes.py no longer defines {missing}. If a fake moved out, the suites "
        "that import it from here break; if it was renamed, update _FAKE_NAMES."
    )


@pytest.mark.parametrize("suite", _CATEGORY_SUITES, ids=lambda p: p.name)
def test_no_category_suite_re_defines_a_shared_fake(suite):
    # [G1] fail-on-revert for copy-paste drift: re-adding `class FakeTable` (or any fake) to a
    # suite means two definitions again, and the copy can drift away from the real 4KB guard
    # while every test stays green. The grep the implementer ran, made durable.
    redefined = sorted(_top_level_bindings(suite) & _FAKE_NAMES)
    assert not redefined, (
        f"{suite.name} re-defines shared category fakes {redefined} that live in "
        "tests/shared/_category_fakes.py. Delete the local copy and import it — a second "
        "definition drifts and starts passing what the shared fake rejects (WHIT-440)."
    )


def test_category_fakes_imports_without_botocore_installed():
    # [G2] fail-on-revert for the lazy-ClientError timing: the three error factories import
    # ClientError INSIDE the function on purpose. If someone "tidies" that to a module-top
    # `from botocore.exceptions import ClientError`, importing _category_fakes would need
    # botocore already faked — which only holds under some collection orders. Prove the import
    # survives with botocore removed from sys.modules entirely.
    keys = ("botocore", "botocore.exceptions", "_category_fakes")
    saved = {k: sys.modules.get(k) for k in keys}
    try:
        for k in keys:
            sys.modules.pop(k, None)
        assert "botocore" not in sys.modules  # precondition: really absent
        module = importlib.import_module("_category_fakes")  # must NOT raise ImportError
        assert hasattr(module, "FakeTable")
    finally:
        for k, original in saved.items():
            if original is not None:
                sys.modules[k] = original
            else:
                sys.modules.pop(k, None)
