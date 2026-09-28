"""WHIT-632: the windowed transaction read has one name, and the build-staging tests live in one file.

The handler used to wrap the shared `read_window` in a private pass-through. Two names for one read
→ people keep using the old one. The old name is built from parts below so this file never matches
its own search.
"""

import ast
import pathlib
import subprocess

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_OLD_WRAPPER_NAME = "_fetch_" + "windowed_transactions"
_STAGING_TESTS = _REPO_ROOT / "tests" / "lambda_api" / "test_lambda_api_build_staging.py"
_STAGING_EDGES_TESTS = _REPO_ROOT / "tests" / "lambda_api" / "test_lambda_api_build_staging_edges.py"


def test_no_file_in_the_repo_mentions_the_old_windowed_read_wrapper():
    found = subprocess.run(
        ["git", "grep", "--untracked", "-n", _OLD_WRAPPER_NAME, "--", ".", ":!.build"],
        cwd=_REPO_ROOT,
        capture_output=True,
        text=True,
    )
    # git grep exits 1 when nothing matches, 0 when something does, >1 on error.
    assert found.returncode in (0, 1), found.stderr
    assert found.stdout == "", f"still mentions {_OLD_WRAPPER_NAME}; use read_window:\n{found.stdout}"


def test_all_seven_build_staging_cases_live_in_one_file():
    assert not _STAGING_EDGES_TESTS.exists(), "merge the edges file into test_lambda_api_build_staging.py"
    tree = ast.parse(_STAGING_TESTS.read_text())
    test_names = {
        node.name for node in tree.body if isinstance(node, ast.FunctionDef) and node.name.startswith("test_")
    }
    assert test_names == {
        "test_stages_only_top_level_tracked_py_with_their_disk_content",
        "test_outside_a_git_checkout_the_build_fails_loudly",
        "test_with_no_tracked_lambda_api_files_the_build_fails_loudly",
        "test_a_rebuild_drops_a_module_that_is_no_longer_tracked",
        "test_a_tracked_module_missing_from_disk_fails_the_build",
        "test_the_build_works_when_started_from_outside_the_repo",
        "test_the_webhook_lambda_dir_is_still_ignored_except_its_sources",
    }
