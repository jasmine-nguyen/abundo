"""WHIT-626 — run the REAL build script's `lambda_api` target in a sandbox git repo.

scripts/tests/build_artifacts_test.sh only runs in the deploy workflow; these run with pytest on
every build, and cover the edges it doesn't:
  [A1] nested files  [A3] an empty index
  [A4] a rebuild after a module stops being tracked  [A5] a tracked module missing from disk
  [A6] a build started from outside the repo (terraform's local-exec cwd)
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
    # Stop git discovering an enclosing repo above the sandbox.
    env["GIT_CEILING_DIRECTORIES"] = str(sandbox.parent)
    return env


def _sandbox(tmp_path: pathlib.Path, init_git: bool = True) -> pathlib.Path:
    root = tmp_path / "repo"
    (root / "scripts").mkdir(parents=True)
    shutil.copy(_SCRIPT, root / "scripts" / _SCRIPT.name)
    (root / "lambda_api").mkdir()
    if init_git:
        _git(root, "init", "-q")
    return root


def _git(root: pathlib.Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=root, env=_env(root), check=True, capture_output=True)


def _write(root: pathlib.Path, relative: str, body: str) -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body)


def _build(root: pathlib.Path, cwd: pathlib.Path | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(root / "scripts" / _SCRIPT.name), "lambda_api"],
        cwd=cwd or root, env=_env(root), capture_output=True, text=True,
    )


def _staged(root: pathlib.Path) -> set[str]:
    return {path.name for path in (root / "terraform" / "build" / "lambda_api").iterdir()}


def test_stages_only_top_level_tracked_py_with_their_disk_content(tmp_path):
    # [A1] tracked top-level *.py ship; untracked, nested and non-.py files don't.
    root = _sandbox(tmp_path)
    _write(root, "lambda_api/handler.py", "HANDLER = 1\n")
    _write(root, "lambda_api/new_module.py", "NEW = 2\n")
    _write(root, "lambda_api/sub/nested.py", "NESTED = 3\n")
    _write(root, "lambda_api/notes.txt", "not python\n")
    _git(root, "add", "lambda_api")
    _write(root, "lambda_api/untracked_cruft.py", "CRUFT = 4\n")

    result = _build(root)

    assert result.returncode == 0, result.stderr
    assert _staged(root) == {"handler.py", "new_module.py"}
    staged_dir = root / "terraform" / "build" / "lambda_api"
    assert (staged_dir / "new_module.py").read_text() == "NEW = 2\n"


def test_with_no_tracked_lambda_api_files_the_build_fails_loudly(tmp_path):
    # [A3] a repo whose index has no lambda_api/*.py (e.g. wrong root) -> non-zero, clear message.
    root = _sandbox(tmp_path)
    _write(root, "lambda_api/handler.py", "HANDLER = 1\n")

    result = _build(root)

    assert result.returncode != 0
    assert "no tracked lambda_api/*.py" in result.stderr


def test_a_rebuild_drops_a_module_that_is_no_longer_tracked(tmp_path):
    # [A4] untracking a module (file left on disk) removes it from the next bundle.
    root = _sandbox(tmp_path)
    _write(root, "lambda_api/handler.py", "HANDLER = 1\n")
    _write(root, "lambda_api/repository.py", "STALE = 1\n")
    _git(root, "add", "lambda_api")
    assert _build(root).returncode == 0
    assert "repository.py" in _staged(root)

    _git(root, "rm", "-q", "--cached", "lambda_api/repository.py")
    result = _build(root)

    assert result.returncode == 0, result.stderr
    assert _staged(root) == {"handler.py"}


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
