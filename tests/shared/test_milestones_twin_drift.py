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

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_TS_TWIN = _REPO_ROOT / "src" / "milestones.ts"

# One TS milestone row, e.g.
#   { sprint: 0, label: 'Kickoff', targetBalance: 544000, targetDate: '2026-06-18' },
_TS_ROW = re.compile(
    r"\{\s*sprint:\s*(?P<sprint>\d+)\s*,"
    r"\s*label:\s*'(?P<label>[^']*)'\s*,"
    r"\s*targetBalance:\s*(?P<balance>\d+)\s*,"
)


def _ts_milestones() -> list:
    """The (sprint, label, target_balance) rows parsed out of src/milestones.ts.

    Scoped to the `export const MILESTONES: Milestone[] = [ ... ];` array so an
    unrelated `sprint:`/`targetBalance:` elsewhere in the file could never leak in."""
    text = _TS_TWIN.read_text()
    block = re.search(r"export const MILESTONES\s*:[^=]*=\s*\[(.*?)\]", text, re.DOTALL)
    assert block, "could not locate the MILESTONES array in src/milestones.ts"
    rows = [
        (int(m.group("sprint")), m.group("label"), int(m.group("balance")))
        for m in _TS_ROW.finditer(block.group(1))
    ]
    assert rows, "parsed zero milestone rows from src/milestones.ts (row shape changed?)"
    return rows


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
