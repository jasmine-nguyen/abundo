"""Adversarial checks for the WHIT-634 push `paths-ignore` filter and the shared reader.

Covers what the pin test doesn't: that each event's list is read from its own block and
its own key, and that the live workflows never mix `paths` and `paths-ignore` on one event
(GitHub rejects a workflow that does, so neither suite would run at all).
"""

import pathlib
import re

import pytest

from _workflow_paths import pull_request_paths, push_paths_ignore

_WORKFLOWS = pathlib.Path(__file__).resolve().parents[2] / ".github" / "workflows"
_TEST_WORKFLOWS = ["client-tests.yml", "python-tests.yml"]


def _event_block(text: str, event: str) -> str:
    match = re.search(
        rf"^(?P<indent>[ \t]*){event}:[ \t]*\n(?P<body>(?:(?P=indent)[ \t]+.*\n|[ \t]*\n)*)",
        text,
        re.M,
    )
    assert match, f"no `{event}:` block"
    return match.group("body")


# [A1]
def test_pull_request_reader_ignores_push_paths_ignore_declared_above_it():
    text = (
        "on:\n"
        "  push:\n"
        "    branches: [main]\n"
        "    paths-ignore:\n"
        '      - ".claude/**"\n'
        '      - "**/*.md"\n'
        "  pull_request:\n"
        "    paths:\n"
        '      - "src/**"\n'
    )
    assert pull_request_paths(text) == ["src/**"]


# [A2]
def test_each_reader_matches_its_key_exactly_not_by_prefix():
    """`paths:` must not pick up a `paths-ignore:` list, and vice versa."""
    text = (
        "on:\n"
        "  push:\n"
        "    branches: [main]\n"
        "    paths:\n"
        '      - "src/**"\n'
        "    paths-ignore:\n"
        '      - "build_graph.py"\n'
        "  pull_request:\n"
        "    paths-ignore:\n"
        '      - "docs/**"\n'
        "    paths:\n"
        '      - "shared/**"\n'
    )
    assert push_paths_ignore(text) == ["build_graph.py"]
    assert pull_request_paths(text) == ["shared/**"]


# [A3]
def test_push_without_paths_ignore_fails_instead_of_reading_the_next_block():
    text = (
        "on:\n"
        "  push:\n"
        "    branches: [main]\n"
        "  pull_request:\n"
        "    paths-ignore:\n"
        '      - "src/**"\n'
    )
    with pytest.raises(AssertionError, match="parsed zero entries out of on.push.paths-ignore"):
        push_paths_ignore(text)


# [A4]
@pytest.mark.parametrize("workflow", _TEST_WORKFLOWS)
def test_no_event_mixes_paths_and_paths_ignore(workflow):
    """GitHub refuses a workflow whose event declares both `paths` and `paths-ignore`,
    so a mix here would silently stop the suite from running on main AND on PRs."""
    text = (_WORKFLOWS / workflow).read_text()
    push = _event_block(text, "push")
    pull_request = _event_block(text, "pull_request")
    assert not re.search(r"^\s*paths:", push, re.M), f"{workflow}: push has `paths:` beside `paths-ignore:`"
    assert not re.search(r"^\s*paths-ignore:", pull_request, re.M), (
        f"{workflow}: pull_request has `paths-ignore:` beside `paths:`"
    )


# [A5]
@pytest.mark.parametrize("workflow", _TEST_WORKFLOWS)
def test_push_paths_ignore_has_no_duplicates_and_no_code_globs(workflow):
    entries = push_paths_ignore((_WORKFLOWS / workflow).read_text())
    assert len(entries) == len(set(entries)), f"{workflow}: duplicate paths-ignore entries"
    code_like = [e for e in entries if re.search(r"\.(py|ts|tsx|js|json|txt|yml|ini)$", e) and e != "build_graph.py"]
    assert not code_like, f"{workflow}: paths-ignore skips code/config files {code_like}"


# [A6]
@pytest.mark.parametrize("workflow", _TEST_WORKFLOWS)
def test_both_suites_still_run_on_pull_request(workflow):
    """The push filter must not have replaced or emptied the pull_request trigger."""
    text = (_WORKFLOWS / workflow).read_text()
    paths = pull_request_paths(text)
    assert f".github/workflows/{workflow}" in paths
    assert not set(paths) & {".claude/**", "build_graph.py", "**/*.md"}
