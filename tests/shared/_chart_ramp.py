"""Reads the client's chart colour ramp out of its TypeScript source (WHIT-406).

The ramp (`CATEGORY_COLORS`) and the slot permutation (`ASSIGNMENT_ORDER`) live
client-side, but the server hands out the slots that index them. Server tests need
the real client values to prove the two agree, so this parses the TypeScript as
TEXT — there is no JS runtime in the pytest suite, the same reason
tests/shared/test_milestones_twin_drift.py parses its twin that way.

It DISCOVERS the ramp file by content rather than hard-coding a path: that file has
already moved once (src/theme/chartColors.ts -> src/chartColors.ts, WHIT-408). Finding
it by what it declares means a move within src/ or app/ needs no workflow edit at all —
twin-guards.yml runs the drift job on any src/**/app/** change (WHIT-436), so the
colour-slot guard still runs after a move instead of silently unhooking the reader.

The parsers take TEXT, not a path, so a guard can drive them against fabricated
source and prove they still report drift instead of shrugging.
"""

import pathlib
import re

import _ts_array

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
# Where shipped client source lives. Test trees are excluded below: a fixture
# declaring its own ramp must not be mistaken for the app's.
_CLIENT_DIRS = ("src", "app")

_HEX = re.compile(r"#[0-9a-fA-F]{3,8}")
_INT = re.compile(r"-?\d+")


def _declaration_bodies(text: str, name: str) -> list:
    """The bracketed body of every `export const <name> = [...]` in `text`.

    The ramp has no type annotation and an annotated form must fail loudly, so the shared
    reader is called without `allow_type_annotation` — reproducing the old regex exactly.
    """
    return _ts_array.array_bodies(text, name)


def _one_body(text: str, name: str) -> str:
    """The single declaration's body, or a failure naming what to fix.

    Exactly one, not the first match: a shadowing second declaration (a commented-out
    old ramp left above the live one) would otherwise be parsed instead, and could hide
    a real drift by happening to agree with the server.
    """
    return _ts_array.one_array_body(text, name)


def parse_ramp(text: str) -> list:
    """The CATEGORY_COLORS hex strings declared in `text`."""
    colors = _HEX.findall(_one_body(text, "CATEGORY_COLORS"))
    assert colors, (
        "parsed zero colours out of the CATEGORY_COLORS declaration — the entry shape "
        "changed; update the parser in tests/shared/_chart_ramp.py"
    )
    return colors


def parse_order(text: str) -> list:
    """The ASSIGNMENT_ORDER slot-to-ramp permutation declared in `text`."""
    order = [int(value) for value in _INT.findall(_one_body(text, "ASSIGNMENT_ORDER"))]
    assert order, (
        "parsed zero entries out of the ASSIGNMENT_ORDER declaration — the entry shape "
        "changed; update the parser in tests/shared/_chart_ramp.py"
    )
    return order


def ramp_source_path() -> pathlib.Path:
    """The shipped client file declaring CATEGORY_COLORS.

    Deliberately uncached: the walk costs ~14ms and the guards call it a handful of
    times, while a cache would hide a monkeypatched repo root from the tests that
    exercise discovery.
    """
    matches = [
        path
        for directory in _CLIENT_DIRS
        for path in sorted((_REPO_ROOT / directory).rglob("*.ts*"))
        if "__tests__" not in path.parts
        and _declaration_bodies(path.read_text(), "CATEGORY_COLORS")
    ]
    assert len(matches) == 1, (
        f"expected exactly one shipped client file declaring CATEGORY_COLORS, found "
        f"{len(matches)}: {[str(p.relative_to(_REPO_ROOT)) for p in matches]} — the "
        "colour-slot guard cannot tell which ramp the app actually paints with."
    )
    return matches[0]


def category_colors() -> list:
    """The client's chart colour ramp."""
    return parse_ramp(ramp_source_path().read_text())


def assignment_order() -> list:
    """The client's slot -> ramp-position permutation."""
    return parse_order(ramp_source_path().read_text())
