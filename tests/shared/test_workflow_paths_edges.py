"""WHIT-436 — extra edges of the shared workflow-paths reader, beyond the implementer's set.

test_workflow_paths.py already pins: comment lines, push-vs-pull_request scoping, same-indent
list, list-ends-at-next-key, reject `- ""`, raise-on-zero. This file adds the edges it left:
inline trailing comments, `**/` globs, flow-style (a known limitation that fails LOUD, not
silent), a missing pull_request block, tab indentation, duplicates, and a pull_request block
after other keys. Fabricated YAML only, so they keep meaning after a real trigger changes.
"""

import pytest

from _workflow_paths import pull_request_paths


def _pr(paths_block: str) -> str:
    return "on:\n  push:\n    branches: [main]\n  pull_request:\n" + paths_block


# --------------------------------------------------------------- entries read correctly


def test_a_trailing_inline_comment_on_a_quoted_entry_is_stripped():
    # `- "src/**"  # note` — the path is src/**, not `src/**"  # note`.
    text = _pr('    paths:\n      - "src/**"   # client source\n')
    assert pull_request_paths(text) == ["src/**"]


def test_a_trailing_inline_comment_on_a_bare_entry_is_stripped():
    # the bare-scalar branch `([^#\\s]+)` must stop at the `#`, not swallow it.
    text = _pr("    paths:\n      - src/**   # client source\n")
    assert pull_request_paths(text) == ["src/**"]


def test_a_double_star_glob_entry_is_read_whole():
    # `**/requirements*.txt` is a real entry in twin-guards.yml.
    text = _pr('    paths:\n      - "**/requirements*.txt"\n')
    assert pull_request_paths(text) == ["**/requirements*.txt"]


def test_duplicate_entries_are_returned_as_written():
    # Duplicates are harmless (callers wrap in set()); pin that the reader neither dedupes
    # nor crashes, so a caller's set() stays the contract.
    text = _pr('    paths:\n      - "src/**"\n      - "src/**"\n')
    assert pull_request_paths(text) == ["src/**", "src/**"]


def test_tab_indented_block_is_still_read():
    # YAML forbids tab indentation, but a consistently-tabbed file still reads via the
    # char-count column logic — documents the behaviour is tolerant, not silently empty.
    text = 'on:\n\tpull_request:\n\t\tpaths:\n\t\t\t- "src/**"\n'
    assert pull_request_paths(text) == ["src/**"]


# --------------------------------------------- loud failure, never a silent empty read


def test_flow_style_paths_raise_rather_than_read_empty():
    # `paths: [ "a", "b" ]` is valid YAML the reader does not parse. It must raise the
    # vacuity guard, not silently return [] and make every caller's assertion pass for free.
    text = _pr('    paths: [ "src/**", "app/**" ]\n')
    with pytest.raises(AssertionError, match="parsed zero entries"):
        pull_request_paths(text)


def test_a_workflow_with_no_pull_request_block_raises():
    # A push-only workflow has no pull_request paths; asserting against it must fail loud,
    # not report the push paths as if they were pull_request's.
    text = 'on:\n  push:\n    paths:\n      - "src/**"\n'
    with pytest.raises(AssertionError, match="parsed zero entries"):
        pull_request_paths(text)


def test_a_pull_request_block_with_branches_but_no_paths_raises():
    text = "on:\n  pull_request:\n    branches: [main]\njobs:\n  x:\n    runs-on: ubuntu\n"
    with pytest.raises(AssertionError, match="parsed zero entries"):
        pull_request_paths(text)


def test_pull_request_after_other_on_keys_is_still_found():
    # pull_request declared below push + workflow_dispatch must still be located and read.
    text = (
        "on:\n"
        "  push:\n"
        "    branches: [main]\n"
        "  workflow_dispatch:\n"
        "  pull_request:\n"
        "    paths:\n"
        '      - "src/**"\n'
    )
    assert pull_request_paths(text) == ["src/**"]
