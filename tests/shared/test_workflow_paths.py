"""Behaviour of the shared workflow-paths reader (WHIT-435 / WHIT-436).

The reader replaces two divergent hand-rolled copies. It runs against fabricated YAML
here (never a real workflow), so these keep meaning after a real trigger legitimately
changes. Trimmed to one fail-on-revert check per reader behaviour the live twin-guards
assertion depends on (WHIT-453): comment stripping, push-vs-pull_request scoping,
end-of-list, empty-entry reject, and the raise-on-zero vacuity guard.
"""

import pytest

from _workflow_paths import pull_request_paths

_BASE = (
    "on:\n"
    "  push:\n"
    "    branches: [main]\n"
    "  pull_request:\n"
    "    paths:\n"
    '      - "src/**"\n'
    '      - "shared/**"\n'
)


def test_reads_the_pull_request_paths():
    assert pull_request_paths(_BASE) == ["src/**", "shared/**"]


def test_ignores_comments_whole_line_and_inline():
    """A `#`-commented path is not a live trigger, and an inline `# note` after a real
    entry is not part of the path. A substring search would get both wrong; this reader
    must not — twin-guards.yml itself carries inline comments on its path entries."""
    # A commented-out entry dedented to the `paths:` key indent must be SKIPPED, not read
    # as an entry and not mistaken for the dedent that ends the list.
    commented = (
        "on:\n"
        "  pull_request:\n"
        "    paths:\n"
        '      - "src/**"\n'
        '    # - "app/**"\n'
        '      - "shared/**"\n'
    )
    assert pull_request_paths(commented) == ["src/**", "shared/**"]
    inline_quoted = pull_request_paths(
        'on:\n  pull_request:\n    paths:\n      - "src/**"   # client source\n'
    )
    assert inline_quoted == ["src/**"]
    inline_bare = pull_request_paths(
        "on:\n  pull_request:\n    paths:\n      - src/**   # client source\n"
    )
    assert inline_bare == ["src/**"]


def test_reads_a_push_paths_filter_does_not_leak_into_pull_request():
    """`push:` is declared above `pull_request:` and could grow its own paths filter.
    The reader is scoped to the pull_request block, so a push path must not appear."""
    text = (
        "on:\n"
        "  push:\n"
        "    paths:\n"
        '      - "docs/**"\n'
        "  pull_request:\n"
        "    paths:\n"
        '      - "src/**"\n'
    )
    assert pull_request_paths(text) == ["src/**"]


def test_a_list_at_the_same_indent_as_its_key_still_counts():
    """The behaviour the two old hand-rolled copies disagreed on, and the reason this single
    reader exists: YAML allows the list at the SAME column as `paths:`. A `column <= indent:
    break` simplification would pass every other test here yet silently read an empty list."""
    text = 'on:\n  pull_request:\n    paths:\n    - "src/**"\n    - "app/**"\n'
    assert pull_request_paths(text) == ["src/**", "app/**"]


def test_the_list_ends_at_the_next_key():
    """A dedented, non-list line (the next mapping key) ends the paths list — a later
    key's value must not be swept in as a path."""
    text = _BASE + "  branches:\n    - main\n"
    assert pull_request_paths(text) == ["src/**", "shared/**"]


def test_an_empty_entry_is_rejected():
    """`- ""` matches nothing and is almost certainly a mistake; both old copies accepted
    it silently. The reader must refuse it loudly."""
    for empty in ('      - ""\n', "      - ''\n"):
        with pytest.raises(AssertionError, match="empty path entry"):
            pull_request_paths(_BASE + empty)


def test_a_reader_that_finds_nothing_fails_loudly():
    """The vacuity guard: a shape the reader can't read must raise, not return an empty list
    that makes every caller's assertion pass for free. Covers both a block with no `paths:`
    key and flow-style `paths: [ ... ]` (valid YAML the line-based reader does not parse)."""
    unreadable = (
        "on:\n  pull_request:\n    branches: [main]\n",       # no paths: key at all
        'on:\n  pull_request:\n    paths: [ "src/**" ]\n',    # flow-style, unsupported
    )
    for shape in unreadable:
        with pytest.raises(AssertionError, match="parsed zero entries"):
            pull_request_paths(shape)
