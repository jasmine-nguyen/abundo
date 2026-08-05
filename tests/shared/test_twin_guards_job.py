"""The twin-guard drift job must actually wake, and run the marker unscoped (WHIT-436).

A guard that never runs is not a guard — and that applies to the guard-running job too.
twin-guards.yml fires only on CLIENT changes now (WHIT-453): a server change already runs
every crosslang guard through python-tests.yml's full suite, so firing the job on server
paths too was a pure double run. That narrowing is only safe while python-tests.yml both
(a) FIRES on every server path and (b) runs the WHOLE suite — so this file pins both halves
there, plus twin-guards' own client trigger + unscoped command. Marked `crosslang` so these
run inside the very job they police.
"""

import pathlib
import shlex

import pytest

import _chart_ramp
from _workflow_paths import pull_request_paths

pytestmark = pytest.mark.crosslang

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_WORKFLOWS = _REPO_ROOT / ".github" / "workflows"
_TWIN_GUARDS = _WORKFLOWS / "twin-guards.yml"
_PYTHON_TESTS = _WORKFLOWS / "python-tests.yml"

_SERVER_DIRS = {"shared/**", "lambda*/**", "tests/**"}


def _pytest_command(text: str) -> str:
    """Join a (possibly line-continued) `python -m pytest ...` command into one string."""
    lines = text.splitlines()
    for index, line in enumerate(lines):
        if "python -m pytest" not in line or line.strip().startswith("#"):
            continue
        collected = [line]
        while collected[-1].rstrip().endswith("\\") and index + len(collected) < len(lines):
            collected.append(lines[index + len(collected)])
        return " ".join(part.strip().rstrip("\\").strip() for part in collected)
    return ""


def _pytest_args(text: str) -> list:
    """The pytest arg tokens (everything after `pytest`) for a workflow's pytest step."""
    command = _pytest_command(text)
    if not command:
        return []
    tokens = shlex.split(command)
    return tokens[tokens.index("pytest") + 1:] if "pytest" in tokens else []


def _suite_narrowing_flags(args: list) -> list:
    """Flags that make pytest run only a SUBSET: `-m`/`-k` select by expression (glued or
    spaced), `--ignore`/`--deselect` carve tests out of an otherwise-whole run. A server
    suite carrying any of them is no longer guaranteed to run every crosslang guard."""
    return [
        arg for arg in args
        if arg.startswith("-m") or arg.startswith("-k")
        or arg.startswith("--ignore") or arg.startswith("--deselect")
    ]


def _positional_test_paths(args: list) -> list:
    """A bare `tests` / `tests/...` positional — scopes the run to a subtree, skipping a
    marked guard living elsewhere. (An `--ignore=tests/x` flag is NOT this — it starts a
    whole-suite run minus one dir — so only positionals count.)"""
    return [
        arg for arg in args
        if not arg.startswith("-") and (arg == "tests" or arg.startswith("tests/"))
    ]


def test_the_trigger_covers_every_client_source_dir():
    """The job exists to cover a client-only PR (which skips python-tests.yml). If its
    trigger stopped covering a client dir, that gap reopens. Assert the trigger is a
    superset of the real client dirs (read from _chart_ramp._CLIENT_DIRS, not hard-coded).
    Server dirs are deliberately NOT required — python-tests.yml owns those."""
    paths = set(pull_request_paths(_TWIN_GUARDS.read_text()))
    required = {f"{directory}/**" for directory in _chart_ramp._CLIENT_DIRS}
    missing = required - paths
    assert not missing, (
        f"on.pull_request.paths of {_TWIN_GUARDS.name} is missing {sorted(missing)} — a "
        f"change under one of those client dirs would skip the twin-guard job, reopening "
        f"the cross-language gap it closes. Present: {sorted(paths)}"
    )


def test_the_job_runs_the_marker_unscoped():
    """`pytest -m crosslang` must run with NO test-path positional: scoping it to a couple
    of dirs would silently skip a marked guard added elsewhere. And it must actually
    select the marker, not run the whole suite."""
    args = _pytest_args(_TWIN_GUARDS.read_text())
    assert args, f"no `python -m pytest` command found in {_TWIN_GUARDS.name}"
    assert "-m" in args and "crosslang" in args, (
        f"the twin-guard job must select the marker with `-m crosslang`; found: {args}"
    )
    scoped = _positional_test_paths(args)
    assert not scoped, (
        f"the twin-guard job pins a test path ({scoped}) — run `-m crosslang` unscoped so "
        "a marked guard in any directory is picked up."
    )


def test_python_tests_runs_the_whole_suite_so_the_server_side_is_covered():
    """Dropping the server paths from twin-guards.yml is only safe because python-tests.yml
    runs the WHOLE suite (every crosslang guard) on any server change. Pin that: a marker
    (`-m`) or keyword (`-k`) filter, or a scoped test path, would silently drop server-side
    crosslang coverage with twin-guards no longer firing on server paths to catch it."""
    args = _pytest_args(_PYTHON_TESTS.read_text())
    assert args, f"no `python -m pytest` command found in {_PYTHON_TESTS.name}"
    narrowing = _suite_narrowing_flags(args)
    assert not narrowing, (
        f"python-tests.yml runs pytest with a suite-narrowing flag ({narrowing}); the "
        "twin-guards narrowing (WHIT-453) relies on this job running EVERY crosslang guard "
        "unscoped. If you must filter, restore the server paths in twin-guards.yml first."
    )
    scoped = _positional_test_paths(args)
    assert not scoped, (
        f"python-tests.yml scopes pytest to a test path ({scoped}) — it must run the whole "
        "suite so the server side of every crosslang twin guard is covered."
    )


def test_python_tests_still_fires_on_every_server_dir():
    """The other half of "the server side is covered elsewhere": python-tests.yml must
    still TRIGGER on the server dirs. A whole-suite command that never fires protects
    nothing — and twin-guards no longer covers server changes to fall back on. Before
    WHIT-453 this was enforced on twin-guards' own trigger; it moves here with the job that
    now owns server coverage."""
    paths = set(pull_request_paths(_PYTHON_TESTS.read_text()))
    missing = _SERVER_DIRS - paths
    assert not missing, (
        f"on.pull_request.paths of {_PYTHON_TESTS.name} is missing {sorted(missing)} — a "
        f"server change under one of those dirs would run NO crosslang guard on a PR, since "
        f"twin-guards.yml fires on client dirs only. Present: {sorted(paths)}"
    )


def test_the_job_adds_no_new_dependency():
    """The job hand-parses YAML rather than adding PyYAML (Jasmine's call, deferred). Keep
    that honest — it installs only the existing requirements-dev.txt."""
    text = _TWIN_GUARDS.read_text()
    assert "lambda_sync_trigger/requirements-dev.txt" in text
    assert "pyyaml" not in text.lower()
