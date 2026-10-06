"""WHIT-766: no test file keeps its own category / pay-cycle stand-in, under any name.

A copy is found by what it does (a class with no base that defines
``list_categories`` or ``get_paycycle``), not by its name, so renamed copies are
caught too. The shared fakes in ``tests/shared/_*_fakes.py`` are the one home.
"""

import ast
import pathlib

_TESTS = pathlib.Path(__file__).resolve().parents[1]                 # tests/

_REPO_METHODS = {"list_categories", "get_paycycle"}

# The full create/update/delete category fake, not a read-only stand-in.
_ALLOWED = {"lambda_api/test_categories.py": {"FakeCategoryRepo"}}


def _local_copies(source):
    found = []
    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, ast.ClassDef) or node.bases:
            continue
        methods = {item.name for item in node.body if isinstance(item, ast.FunctionDef)}
        if methods & _REPO_METHODS:
            found.append((node.lineno, node.name))
    return found


def _is_shared_fake_module(relative):
    return relative.startswith("shared/_") and relative.endswith("_fakes.py") and "/" not in relative[len("shared/"):]


def test_no_test_file_defines_its_own_category_or_pay_cycle_stand_in():
    nested = (
        "def test_x():\n"
        "    class _Renamed:\n"
        "        def get_paycycle(self):\n"
        "            return {}\n"
    )
    assert _local_copies(nested) == [(2, "_Renamed")]

    copies = []
    for path in sorted(_TESTS.rglob("*.py")):
        relative = path.relative_to(_TESTS).as_posix()
        if _is_shared_fake_module(relative):
            continue
        allowed = _ALLOWED.get(relative, set())
        for lineno, name in _local_copies(path.read_text()):
            if name in allowed:
                continue
            copies.append(f"{relative}:{lineno} class {name}")
    assert not copies, (
        "import _FakePayCycleRepo / _FakeCategoryRepo (_budget_endpoint_fakes) or "
        "FakeCategoryRepo (_feed_fakes) instead:\n" + "\n".join(copies))
