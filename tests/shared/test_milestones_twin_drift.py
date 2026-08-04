"""Cross-file drift-pin for the payoff-milestone plan (WHIT-306).

The milestone plan is transcribed into TWO files that must stay identical:

    - shared/milestones.py  (`MILESTONES`)  -> drives the celebration push
    - src/milestones.ts     (`MILESTONES`)  -> drives the in-app milestone screen

Each file already has its own drift-pin, but nothing proved the two lists match
EACH OTHER. If someone edits one and forgets the other, the push would name a
different balance/label than the screen and no test would catch it (WHIT-301
follow-up). This reads both files and asserts the (sprint, label, target balance)
rows are identical, in order — so a one-sided edit fails loudly.

It deliberately parses the TypeScript twin as TEXT (no JS runtime in the pytest
suite): the row shape is fixed and pinned by the TS side's own load-time invariant,
so a simple regex over the `export const MILESTONES` block is enough.
"""

import pathlib
import re

import pytest

import _ts_array

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_TS_TWIN = _REPO_ROOT / "src" / "milestones.ts"

# One TS milestone row, e.g.
#   { sprint: 0, label: 'Kickoff', targetBalance: 544000, targetDate: '2026-06-18' },
_TS_ROW = re.compile(
    r"\{\s*sprint:\s*(?P<sprint>\d+)\s*,"
    r"\s*label:\s*'(?P<label>[^']*)'\s*,"
    r"\s*targetBalance:\s*(?P<balance>\d+)\s*,"
)


def _parse_ts_milestones(text: str) -> list:
    """The (sprint, label, target_balance) rows in `text`'s MILESTONES array.

    Takes TEXT (not a path) so a meta-guard can drive it against fabricated source. The
    block is located by the shared _ts_array reader, which strips comments and pins
    exactly one `export const MILESTONES = [...]` — so a commented-out or duplicate block
    can no longer fool the first-match `re.search` this used to be. `allow_type_annotation`
    is on because the real declaration is `export const MILESTONES: Milestone[] = [...]`.
    Scoping to that one block also stops an unrelated `sprint:`/`targetBalance:` elsewhere
    in the file leaking in.
    """
    body = _ts_array.one_array_body(text, "MILESTONES", allow_type_annotation=True)
    rows = [
        (int(m.group("sprint")), m.group("label"), int(m.group("balance")))
        for m in _TS_ROW.finditer(body)
    ]
    assert rows, "parsed zero milestone rows from src/milestones.ts (row shape changed?)"
    return rows


def _ts_milestones() -> list:
    """The (sprint, label, target_balance) rows parsed out of src/milestones.ts."""
    return _parse_ts_milestones(_TS_TWIN.read_text())


def test_ts_twin_parses_to_the_expected_shape():
    """Sanity-guard the parser itself: if the TS row format is reworked so this regex
    stops matching, fail here (a clear 'update the parser' signal) rather than letting
    the comparison below pass vacuously on an empty list."""
    rows = _ts_milestones()
    assert len(rows) == 5
    assert rows[0] == (0, "Kickoff", 544000)


def test_python_and_ts_milestone_tables_are_identical(shared):
    """The server push table and the client screen table must match row-for-row on
    (sprint, label, target balance). Edit one file's plan without the other -> red."""
    py_rows = [(m.sprint, m.label, m.target_balance) for m in shared.milestones.MILESTONES]
    assert py_rows == _ts_milestones()


# ------------------------------------------------------- WHIT-446 behaviour-change guards
# The twin-drift read used to be a bare first-match `re.search` with no comment-strip and
# no exactly-one pin. Routing it through _ts_array gained both. Each test below drives the
# text-taking `_parse_ts_milestones` on FABRICATED source and goes RED if that delegation
# is reverted to the old read — the fail-on-revert proof the DoD requires.


def test_two_live_milestones_blocks_now_fail_instead_of_silently_taking_the_first():
    """The old first-match read took the FIRST of two `export const MILESTONES` blocks and
    passed. A stale block left above the live one can hide real drift by happening to agree
    with the server, so exactly-one now rejects it. Revert the delegation and this greens."""
    duplicate = (
        "export const MILESTONES: Milestone[] = [\n"
        "  { sprint: 0, label: 'Stale', targetBalance: 1, targetDate: '2026-01-01' },\n"
        "];\n"
        "export const MILESTONES: Milestone[] = [\n"
        "  { sprint: 0, label: 'Live', targetBalance: 2, targetDate: '2026-02-02' },\n"
        "];\n"
    )
    with pytest.raises(AssertionError, match="found 2"):
        _parse_ts_milestones(duplicate)


def test_a_commented_out_milestones_block_is_ignored_not_read_as_live():
    """A stale `/* ... */`-commented block above the live one used to be read by the old
    no-strip `re.search`. Comments are stripped before the block is located now, so only
    the live rows are seen. Revert and this returns the stale rows -> red."""
    src = (
        "/*\n"
        "export const MILESTONES: Milestone[] = [\n"
        "  { sprint: 9, label: 'Stale', targetBalance: 999, targetDate: '2026-01-01' },\n"
        "];\n"
        "*/\n"
        "export const MILESTONES: Milestone[] = [\n"
        "  { sprint: 0, label: 'Live', targetBalance: 5, targetDate: '2026-02-02' },\n"
        "];\n"
    )
    assert _parse_ts_milestones(src) == [(0, "Live", 5)]


def test_a_bracket_in_a_comment_does_not_truncate_the_milestones_block():
    """Comments are stripped BEFORE the body is located, so a `]` inside a `//` comment
    mid-array cannot end the body early. The old raw-text read stopped at that bracket and
    dropped every row after it. Revert and the second row is lost -> red."""
    src = (
        "export const MILESTONES: Milestone[] = [\n"
        "  { sprint: 0, label: 'One', targetBalance: 1, targetDate: '2026-01-01' }, // ] here\n"
        "  { sprint: 1, label: 'Two', targetBalance: 2, targetDate: '2026-02-02' },\n"
        "];\n"
    )
    assert _parse_ts_milestones(src) == [(0, "One", 1), (1, "Two", 2)]
