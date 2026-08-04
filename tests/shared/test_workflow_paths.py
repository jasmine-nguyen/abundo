"""Edge behaviour of the shared workflow-paths reader (WHIT-435 / WHIT-436).

The reader replaces two divergent hand-rolled copies. It runs against fabricated YAML
here (never a real workflow), so these keep meaning after a real trigger legitimately
changes — and they pin the exact behaviours the two old copies disagreed on.
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


def test_ignores_a_commented_out_entry():
    """A `#`-commented path is not a live trigger — GitHub ignores it. A substring search
    would report it present; this reader must not."""
    text = _BASE + '      # - "app/**"\n'
    assert pull_request_paths(text) == ["src/**", "shared/**"]


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
    """The behaviour the two old copies disagreed on: YAML allows the list at the same
    column as `paths:`. The old `test_chart_ramp_parser_edges` copy broke on the first
    such line and read an empty list; this must read the entries."""
    text = (
        "on:\n"
        "  pull_request:\n"
        "    paths:\n"
        '    - "src/**"\n'
        '    - "app/**"\n'
    )
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
    """The vacuity guard: a pull_request block with no paths (or a shape the reader no
    longer understands) must raise, not return an empty list that makes every caller's
    assertion pass for free."""
    with pytest.raises(AssertionError, match="parsed zero entries"):
        pull_request_paths("on:\n  pull_request:\n    branches: [main]\n")
