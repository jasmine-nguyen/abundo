"""A tooling/docs-only push to main skips the test suites; any code push still runs them (WHIT-634).

Both test workflows fire on `push` to main. The `paths-ignore` filter skips a push only
when EVERY changed file matches, so the list must stay exactly the agent tooling and
Markdown patterns — widening it (e.g. adding `src/**`) could let code land on main untested.
Hand-parsed via _workflow_paths (no PyYAML on the CI runner).
"""

import pathlib
import re

import pytest

from _workflow_paths import push_paths_ignore

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_WORKFLOWS = _REPO_ROOT / ".github" / "workflows"

_TOOLING_AND_DOCS = {".claude/**", "build_graph.py", "**/*.md"}

# The `push:` block under `on:` — every following line indented deeper than the key.
_PUSH_BLOCK = re.compile(r"^(?P<indent>[ \t]*)push:[ \t]*\n(?P<body>(?:(?P=indent)[ \t]+.*\n|[ \t]*\n)*)", re.M)


@pytest.mark.parametrize("workflow", ["client-tests.yml", "python-tests.yml"])
def test_main_push_skips_only_tooling_and_docs_only_changes(workflow):
    text = (_WORKFLOWS / workflow).read_text()

    push_block = _PUSH_BLOCK.search(text)
    assert push_block, f"{workflow} no longer declares an on.push trigger"
    assert re.search(r"^\s*branches:\s*\[\s*main\s*\]\s*$", push_block.group("body"), re.M), (
        f"{workflow} must still run on every push to main (`branches: [main]` under push:)"
    )

    assert set(push_paths_ignore(text)) == _TOOLING_AND_DOCS, (
        f"{workflow}'s on.push.paths-ignore must be exactly {sorted(_TOOLING_AND_DOCS)}. "
        "Widening it can stop code pushed to main from being tested; narrowing it wastes "
        "Actions minutes on tooling/docs-only pushes."
    )


def test_the_pin_adds_no_yaml_dependency():
    """CI installs only lambda_sync_trigger/requirements-dev.txt, so `import yaml` would
    ImportError on the runner. Keep this guard hand-parsed."""
    source = pathlib.Path(__file__).read_text()
    assert not re.search(r"^\s*(import\s+yaml|from\s+yaml\s+import)\b", source, re.M)
