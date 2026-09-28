"""WHIT-626 QA — more edges of the REAL build script's `lambda_api` target, in a sandbox git repo.

Complements test_lambda_api_build_staging.py: a tracked module missing from disk, a build started
from outside the repo (terraform's local-exec cwd), and the `lambda/` ignore block that must stay.
"""

import os
import pathlib
import shutil
import subprocess

import pytest

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_SCRIPT = _REPO_ROOT / "scripts" / "build_terraform_artifacts.sh"

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="git is required")


def _env(sandbox: pathlib.Path) -> dict:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env["GIT_CEILING_DIRECTORIES"] = str(sandbox.parent)
    return env


def _sandbox(tmp_path: pathlib.Path) -> pathlib.Path:
    root = tmp_path / "repo"
    (root / "scripts").mkdir(parents=True)
    shutil.copy(_SCRIPT, root / "scripts" / _SCRIPT.name)
    (root / "lambda_api").mkdir()
    _git(root, "init", "-q")
    return root


def _git(root: pathlib.Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=root, env=_env(root), capture_output=True, text=True)


def _build(root: pathlib.Path, cwd: pathlib.Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(root / "scripts" / _SCRIPT.name), "lambda_api"],
        cwd=cwd, env=_env(root), capture_output=True, text=True,
    )


def _staged(root: pathlib.Path) -> set[str]:
    return {path.name for path in (root / "terraform" / "build" / "lambda_api").iterdir()}


def test_a_tracked_module_missing_from_disk_fails_the_build(tmp_path):
    # [A5] tracked but deleted locally -> non-zero, never a bundle silently missing an import.
    root = _sandbox(tmp_path)
    (root / "lambda_api" / "handler.py").write_text("import merchant_groups\n")
    (root / "lambda_api" / "merchant_groups.py").write_text("X = 1\n")
    _git(root, "add", "lambda_api")
    (root / "lambda_api" / "merchant_groups.py").unlink()

    result = _build(root, cwd=root)

    assert result.returncode != 0


def test_the_build_works_when_started_from_outside_the_repo(tmp_path):
    # [A6] terraform's local-exec runs from terraform/ (or anywhere) -> same tracked set is staged.
    root = _sandbox(tmp_path)
    (root / "lambda_api" / "handler.py").write_text("HANDLER = 1\n")
    (root / "lambda_api" / "ai_chat.py").write_text("CHAT = 1\n")
    _git(root, "add", "lambda_api")
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()

    result = _build(root, cwd=elsewhere)

    assert result.returncode == 0, result.stderr
    assert _staged(root) == {"handler.py", "ai_chat.py"}


def test_the_webhook_lambda_dir_is_still_ignored_except_its_sources():
    # [A7] regression: only the lambda_api block left .gitignore; lambda/ still gets
    # `pip install --target`, so installed packages must stay out of git.
    def ignored(path: str) -> bool:
        return subprocess.run(
            ["git", "check-ignore", "-q", "--no-index", path], cwd=_REPO_ROOT
        ).returncode == 0

    assert ignored("lambda/standardwebhooks/__init__.py")
    assert not ignored("lambda/handler.py")
    assert not ignored("lambda_api/handler.py")
