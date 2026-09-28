"""WHIT-623 slice 3 — the routes, the worker and the webhook all run on shared/rule_book.py.

Guards the card's "done when": the worker imports nothing from handler.py, and the sweep /
re-file / leaf-rule helpers live only in the rule book (so the copies can't drift again).
Behaviour is pinned by the existing route, worker and rule_ingest suites; these parse source.
"""

import ast
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]


def _tree(relative_path: str) -> ast.Module:
    return ast.parse((ROOT / relative_path).read_text())


def _imported_modules(tree: ast.Module) -> set[str]:
    modules = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            modules.add(node.module)
        if isinstance(node, ast.Import):
            modules.update(alias.name for alias in node.names)
    return modules


def _imported_names(tree: ast.Module, module: str) -> set[str]:
    return {
        alias.name
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom) and node.module == module
        for alias in node.names
    }


def test_worker_runs_on_the_rule_book_and_imports_nothing_from_the_handler():
    worker = _tree("lambda_api/apply_rules_worker.py")

    assert "handler" not in _imported_modules(worker)
    assert "RuleBook" in _imported_names(worker, "rule_book")
    assert "WriteLimit" in _imported_names(worker, "rule_book")


def test_sweep_refile_and_leaf_rule_live_only_in_the_rule_book():
    handler = _tree("lambda_api/handler.py")
    handler_functions = {
        node.name for node in ast.walk(handler) if isinstance(node, ast.FunctionDef)
    }

    assert not {"_apply_rules_write_phase", "_refile_rule_touched", "_as_leaf_rule"} & handler_functions
    assert {"RuleBook", "WriteLimit"} <= _imported_names(handler, "rule_book")
    assert "RuleBook" in _imported_names(_tree("lambda/rule_ingest.py"), "rule_book")
