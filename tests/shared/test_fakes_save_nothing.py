"""WHIT-625 slice 3 — the "done when" for the test fakes.

  * No hand-written fake saves data. Every write goes through a real repository over FakeTable,
    so the database rules (notify markers, budgets, pay cycle) run as production wrote them.
    Read-only canned stubs (list_tokens, get_loanfacts, get_paycycle, ...) are fine.
  * Adding a test file needs no list entry: the per-suite registry and its meta-guards are gone,
    and the import-lightness check covers every ``_*_fakes.py`` in this folder on its own.
"""

import ast
import pathlib
import subprocess
import sys

_SHARED_TESTS = pathlib.Path(__file__).resolve().parent     # tests/shared
_TESTS = _SHARED_TESTS.parent                                # tests/
_REPO_ROOT = _TESTS.parent

# Method-name prefixes that save, change or delete data.
_WRITE_PREFIXES = (
    "mark_", "claim_", "release_", "remove_", "delete_", "clear_",
    "set_", "update_", "create_", "put_", "add_",
)

# _dynamo_fakes IS the stand-in table the real repositories write to. _handler_patch_fakes'
# FakeRepo copies no database rule, so swapping it is optional in the plan.
_NOT_REPOSITORY_FAKES = {"_dynamo_fakes", "_handler_patch_fakes"}


def _fake_modules():
    return sorted(_SHARED_TESTS.glob("_*_fakes.py"))


def test_no_hand_written_fake_saves_data():
    saving = []
    for path in _fake_modules():
        if path.stem in _NOT_REPOSITORY_FAKES:
            continue
        for node in ast.parse(path.read_text()).body:
            if not isinstance(node, ast.ClassDef):
                continue
            for item in node.body:
                if isinstance(item, ast.FunctionDef) and item.name.startswith(_WRITE_PREFIXES):
                    saving.append(f"{path.stem}.{node.name}.{item.name}")
    assert saving == [], (
        f"These hand-written fakes still save data: {saving}. Use the real repository over "
        "FakeTable instead, so the database rules aren't copied into the tests."
    )


def test_adding_a_test_file_needs_no_registry_entry():
    for gone in ("test_shared_fakes_tuple_completeness_gaps.py", "test_shared_fakes_contract_gaps.py"):
        assert not (_SHARED_TESTS / gone).exists(), f"{gone} should be deleted"

    this_file = pathlib.Path(__file__).resolve()
    mentions = [
        str(path.relative_to(_REPO_ROOT)) for path in _TESTS.rglob("*.py")
        if path.resolve() != this_file and "_REGISTRY" in path.read_text()
    ]
    assert mentions == [], f"_REGISTRY is still referenced in {mentions}"

    collected = subprocess.run(
        [sys.executable, "-m", "pytest", "--collect-only", "-q", "-p", "no:cacheprovider",
         str(_SHARED_TESTS / "test_fakes_invariants.py")],
        cwd=_REPO_ROOT, capture_output=True, text=True,
    )
    assert collected.returncode == 0, collected.stdout + collected.stderr
    unchecked = [path.stem for path in _fake_modules() if path.stem not in collected.stdout]
    assert unchecked == [], (
        f"The import-lightness check in test_fakes_invariants.py doesn't cover {unchecked}. "
        "It should run over every _*_fakes.py in tests/shared, found from the folder."
    )
