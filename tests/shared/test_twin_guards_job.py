"""The twin-guard drift job must actually wake, and run the marker unscoped (WHIT-436).

A guard that never runs is not a guard — and that applies to the guard-running job too.
If twin-guards.yml's trigger drifts narrower than the client source dirs, or its command
grows a path filter that skips a marked guard, the cross-language gap this job closes
reopens silently. Marked `crosslang` so it runs inside the very job it polices.
"""

import pathlib
import re

import pytest

import _chart_ramp
from _workflow_paths import pull_request_paths

pytestmark = pytest.mark.crosslang

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_WORKFLOW = _REPO_ROOT / ".github" / "workflows" / "twin-guards.yml"


def test_the_trigger_covers_every_client_and_server_source_dir():
    """The job exists because a client-only change skips python-tests.yml. If its own
    trigger stopped covering a client dir, that gap reopens. Assert the trigger is a
    superset of the real client dirs (read from _chart_ramp._CLIENT_DIRS, not hard-coded)
    plus the server dirs and the tests tree."""
    paths = set(pull_request_paths(_WORKFLOW.read_text()))
    required = {f"{directory}/**" for directory in _chart_ramp._CLIENT_DIRS}
    required |= {"shared/**", "lambda*/**", "tests/**"}
    missing = required - paths
    assert not missing, (
        f"on.pull_request.paths of {_WORKFLOW.name} is missing {sorted(missing)} — a "
        f"change under one of those dirs would skip the twin-guard job, reopening the "
        f"cross-language gap it closes. Present: {sorted(paths)}"
    )


def test_the_job_runs_the_marker_unscoped():
    """`pytest -m crosslang` must run with NO test-path positional: scoping it to a couple
    of dirs would silently skip a marked guard added elsewhere. And it must actually
    select the marker, not run the whole suite."""
    command_lines = [
        line.strip()
        for line in _WORKFLOW.read_text().splitlines()
        if "python -m pytest" in line and not line.strip().startswith("#")
    ]
    assert command_lines, f"no `python -m pytest` command found in {_WORKFLOW.name}"
    command = command_lines[0]
    assert "-m crosslang" in command, (
        f"the twin-guard job must select the marker with `-m crosslang`; found: {command}"
    )
    assert not re.search(r"\btests/\S*", command), (
        f"the twin-guard job pins a test path ({command}) — run `-m crosslang` unscoped so "
        "a marked guard in any directory is picked up."
    )


def test_the_job_adds_no_new_dependency():
    """The job hand-parses YAML rather than adding PyYAML (Jasmine's call, deferred). Keep
    that honest — it installs only the existing requirements-dev.txt."""
    text = _WORKFLOW.read_text()
    assert "lambda_sync_trigger/requirements-dev.txt" in text
    assert "pyyaml" not in text.lower()
