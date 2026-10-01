"""WHIT-608 — every server function is name-guarded, and the rule vocabulary has one home.

Static checks (nothing is imported):
  - no module in any lambda*/ folder has the same name as a shared module/package
    (at runtime the function's own copy silently replaces the shared one)
  - the rule vocabulary is defined only in shared/constants.py; no other server file
    (the rule engine, the API's constants) keeps its own copy
"""

import ast
import pathlib

from _lambda_api_constants import constants_namespace

_ROOT = pathlib.Path(__file__).resolve().parents[2]
_SHARED = _ROOT / "shared"

_RULE_VOCAB_NAMES = {"RULE_FIELD_OPERATORS", "RULE_FIELDS", "RULE_OPERATORS", "RULE_LOGIC", "RULE_DIRECTIONS"}
_OLD_ENGINE_COPIES = {"_FIELD_OPERATORS", "_LOGIC"}


def _function_folders() -> dict[str, set[str]]:
    return {
        folder.name: {path.stem for path in folder.glob("*.py")}
        for folder in sorted(_ROOT.glob("lambda*/"))
        if folder.is_dir()
    }


def _shared_names() -> set[str]:
    modules = {path.stem for path in _SHARED.glob("*.py")}
    packages = {
        path.name for path in _SHARED.iterdir()
        if path.is_dir() and path.name not in ("__pycache__", "tests")
    }
    return modules | packages


def _assigned_names(path: pathlib.Path) -> set[str]:
    names = set()
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, ast.Assign):
            names |= {target.id for target in node.targets if isinstance(target, ast.Name)}
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            names.add(node.target.id)
    return names


def test_no_server_function_reuses_a_shared_module_name():
    folders = _function_folders()
    for expected in ("lambda", "lambda_api", "lambda_sync_trigger", "lambda_balance_poller"):
        assert expected in folders, f"scan missed the {expected}/ function folder"
    assert "webhook_repository" in folders["lambda"], "the webhook repository should be lambda/webhook_repository.py"
    assert "handler" in folders["lambda"]
    assert "constants" in _shared_names()

    clashes = sorted(
        f"{folder}/{name}.py"
        for folder, names in folders.items()
        for name in names & _shared_names()
    )
    assert clashes == [], (
        f"{clashes} have the same name as a shared module — at runtime the function's copy "
        "silently replaces the shared one. Rename the function's file."
    )


def test_rule_vocabulary_lives_only_in_shared_constants():
    shared_constants = constants_namespace(_SHARED / "constants.py")
    assert {name: set(ops) for name, ops in shared_constants["RULE_FIELD_OPERATORS"].items()} == {
        "description": {"contains", "equals"},
        "merchant": {"contains", "equals"},
        "category": {"equals"},
        "account": {"equals"},
        "amount": {"less_than", "less_than_or_equal", "greater_than", "greater_than_or_equal"},
        "direction": {"is"},
    }
    assert set(shared_constants["RULE_FIELDS"]) == {
        "description", "merchant", "category", "account", "amount", "direction",
    }
    assert set(shared_constants["RULE_OPERATORS"]) == {
        "contains", "equals", "is",
        "less_than", "less_than_or_equal", "greater_than", "greater_than_or_equal",
    }
    assert set(shared_constants["RULE_LOGIC"]) == {"all", "any"}
    assert set(shared_constants["RULE_DIRECTIONS"]) == {"debit", "credit"}

    copies = []
    server_files = [path for folder in _ROOT.glob("lambda*/") for path in folder.glob("*.py")]
    server_files += [path for path in _SHARED.glob("*.py") if path.name != "constants.py"]
    for path in sorted(server_files):
        found = _assigned_names(path) & (_RULE_VOCAB_NAMES | _OLD_ENGINE_COPIES)
        copies += [f"{path.relative_to(_ROOT)}: {name}" for name in sorted(found)]
    assert copies == [], (
        "the rule vocabulary is defined outside shared/constants.py — import it from "
        f"constants instead: {copies}"
    )
