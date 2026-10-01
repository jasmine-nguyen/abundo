"""WHIT-608 QA — the name guard (G1) catches a clash in ANY server function folder, including ones
added later, and a clash with a shared package. Runs the real guard over a throwaway folder tree."""

import importlib.util
import pathlib

import pytest

_GUARD_PATH = pathlib.Path(__file__).resolve().parent / "test_no_shared_name_shadowing.py"


def _guard(monkeypatch, root):
    spec = importlib.util.spec_from_file_location("_name_guard_under_test", _GUARD_PATH)
    guard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guard)
    monkeypatch.setattr(guard, "_ROOT", root)
    monkeypatch.setattr(guard, "_SHARED", root / "shared")
    return guard


def _tree(root, files):
    for rel in files:
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("")
    return root


_BASE = ["shared/constants.py", "shared/spend.py", "shared/repository.py",
         "lambda/handler.py", "lambda/webhook_repository.py", "lambda_api/handler.py"]


# [A16] (P0) a clean tree passes.
def test_clean_tree_passes(tmp_path, monkeypatch):
    guard = _guard(monkeypatch, _tree(tmp_path, _BASE))
    guard.test_no_function_module_shares_a_name_with_a_shared_module()


# [A17] (P0) the webhook's old deliberate clash is caught.
def test_webhook_repository_clash_is_caught(tmp_path, monkeypatch):
    guard = _guard(monkeypatch, _tree(tmp_path, _BASE + ["lambda/repository.py"]))
    with pytest.raises(AssertionError, match=r"lambda/repository\.py"):
        guard.test_no_function_module_shares_a_name_with_a_shared_module()


# [A18] (P0) a clash in any other lambda_* folder — even a brand-new one — is caught.
@pytest.mark.parametrize("folder", ["lambda_goal_nudge", "lambda_sync_trigger", "lambda_brand_new"])
def test_clash_in_any_function_folder_is_caught(tmp_path, monkeypatch, folder):
    guard = _guard(monkeypatch, _tree(tmp_path, _BASE + [f"{folder}/spend.py"]))
    with pytest.raises(AssertionError, match=rf"{folder}/spend\.py"):
        guard.test_no_function_module_shares_a_name_with_a_shared_module()


# [A19] (P1) a function module named like a shared PACKAGE is caught too.
def test_clash_with_a_shared_package_is_caught(tmp_path, monkeypatch):
    guard = _guard(monkeypatch, _tree(tmp_path, _BASE + ["shared/toolkit/__init__.py",
                                                          "lambda_balance_poller/toolkit.py"]))
    with pytest.raises(AssertionError, match=r"lambda_balance_poller/toolkit\.py"):
        guard.test_no_function_module_shares_a_name_with_a_shared_module()
