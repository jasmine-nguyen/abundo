"""Cross-file drift-pin for the bill-spread cycle bounds (WHIT-505).

SPREAD_MIN_CYCLES / SPREAD_MAX_CYCLES are transcribed into TWO files:

    - shared/constants.py  -> the server validates PUT /budgets/{id}/spread against them
    - src/context.tsx      -> the client clamps the cycle stepper to them

If they drift, the app's stepper offers a value the server 400s (or forbids a valid one).
This reads both files and asserts the two integers match. A one-sided edit fails loudly.

Parses the TypeScript twin as TEXT (no JS runtime in the pytest suite): the declarations
are plain `export const NAME = <int>;`, so a scoped regex is enough.
"""

import pathlib
import re

import pytest

pytestmark = pytest.mark.crosslang

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_TS_TWIN = _REPO_ROOT / "src" / "context.tsx"
_PY_CONSTANTS = _REPO_ROOT / "shared" / "constants.py"


def _ts_const(text: str, name: str) -> int:
    """The integer value of `export const <name> = <int>;` in `text`. Asserts exactly one
    such declaration so a stray duplicate can't be read past silently."""
    matches = re.findall(rf"export const {name}\s*=\s*(\d+)\s*;", text)
    assert len(matches) == 1, f"expected exactly one `export const {name}` in src/context.tsx, found {len(matches)}"
    return int(matches[0])


def _py_const(text: str, name: str) -> int:
    matches = re.findall(rf"^{name}\s*=\s*(\d+)\s*$", text, re.MULTILINE)
    assert len(matches) == 1, f"expected exactly one `{name} = ...` in shared/constants.py, found {len(matches)}"
    return int(matches[0])


def test_client_and_server_spread_cycle_bounds_are_identical():
    # The client stepper clamp MUST match the server's validation bounds. Change one without the
    # other -> red.
    ts = _TS_TWIN.read_text()
    py = _PY_CONSTANTS.read_text()
    assert _ts_const(ts, "SPREAD_MIN_CYCLES") == _py_const(py, "SPREAD_MIN_CYCLES")
    assert _ts_const(ts, "SPREAD_MAX_CYCLES") == _py_const(py, "SPREAD_MAX_CYCLES")
