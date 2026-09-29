"""WHIT-648: /build's commit_all still saves work when a file that was new at build
start becomes ignored mid-build (e.g. a .venv symlink added to the shared info/exclude)."""

import importlib.util
import shutil
import subprocess
import uuid
from pathlib import Path

import pytest

BUILD_GRAPH = Path(__file__).resolve().parents[2] / "build_graph.py"


def sh(*args: str, cwd: Path) -> str:
    return subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True).stdout


@pytest.fixture
def repo(tmp_path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    sh("git", "init", "-b", "main", cwd=repo)
    sh("git", "config", "user.email", "test@example.com", cwd=repo)
    sh("git", "config", "user.name", "Test", cwd=repo)
    shutil.copy(BUILD_GRAPH, repo / "build_graph.py")
    (repo / ".gitignore").write_text("__pycache__/\n")
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-m", "initial", cwd=repo)
    return repo


@pytest.fixture
def build_graph(repo):
    spec = importlib.util.spec_from_file_location(f"build_graph_{uuid.uuid4().hex}", repo / "build_graph.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_commit_skips_a_new_file_that_became_ignored_mid_build(repo, build_graph):
    (repo / "scratch.txt").write_text("x")
    state = {"untracked_at_start": ["scratch.txt"]}
    exclude = repo / sh("git", "rev-parse", "--git-path", "info/exclude", cwd=repo).strip()
    exclude.parent.mkdir(parents=True, exist_ok=True)
    with exclude.open("a") as file:
        file.write("scratch.txt\n")
    (repo / "app.py").write_text("ANSWER = 42\n")

    ok, output = build_graph.commit_all(state, "msg")

    assert ok, output
    committed = sh("git", "show", "--name-only", "--format=", "HEAD", cwd=repo).splitlines()
    assert "app.py" in committed
    assert "scratch.txt" not in committed


def add_to_exclude(repo: Path, line: str) -> None:
    exclude = repo / sh("git", "rev-parse", "--git-path", "info/exclude", cwd=repo).strip()
    exclude.parent.mkdir(parents=True, exist_ok=True)
    with exclude.open("a") as file:
        file.write(line + "\n")


def committed_files(repo: Path) -> list[str]:
    return sh("git", "show", "--name-only", "--format=", "HEAD", cwd=repo).splitlines()


# [A1]
def test_a_new_file_still_untracked_stays_out_of_the_commit(repo, build_graph):
    (repo / "notes.txt").write_text("mine")
    (repo / "scratch.txt").write_text("x")
    state = {"untracked_at_start": ["notes.txt", "scratch.txt"]}
    add_to_exclude(repo, "scratch.txt")
    (repo / "app.py").write_text("ANSWER = 42\n")

    ok, output = build_graph.commit_all(state, "msg")

    assert ok, output
    assert committed_files(repo) == ["app.py"]
    assert "?? notes.txt" in sh("git", "status", "--porcelain", cwd=repo)


# [A2]
def test_a_symlink_that_became_ignored_mid_build_does_not_stop_the_commit(repo, build_graph, tmp_path):
    shared = tmp_path / "shared_venv"
    shared.mkdir()
    (repo / ".venv").symlink_to(shared)
    state = {"untracked_at_start": [".venv"]}
    add_to_exclude(repo, ".venv")
    (repo / "app.py").write_text("ANSWER = 42\n")

    ok, output = build_graph.commit_all(state, "msg")

    assert ok, output
    assert committed_files(repo) == ["app.py"]
