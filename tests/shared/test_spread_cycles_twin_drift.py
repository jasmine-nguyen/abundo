"""Cross-file drift-pin for the bill-spread cycle bounds (WHIT-505).

SPREAD_MIN_CYCLES / SPREAD_MAX_CYCLES are transcribed into TWO files:

    - lambda_api/constants.py  -> the server validates PUT /budgets/{id}/spread against them
    - src/context.tsx          -> the client clamps the cycle stepper to them

If they drift, the app's stepper offers a value the server 400s (or forbids a valid one).
Unlike the WHIT-136 shared-constants pair, nothing guarded this one — so this reads both
files and asserts the two integers match. A one-sided edit fails loudly.

Parses the TypeScript twin as TEXT (no JS runtime in the pytest suite): the declarations
are plain `export const NAME = <int>;`, so a scoped regex is enough.
"""

import pathlib
import re

import pytest

pytestmark = pytest.mark.crosslang

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_TS_TWIN = _REPO_ROOT / "src" / "context.tsx"
_PY_CONSTANTS = _REPO_ROOT / "lambda_api" / "constants.py"


def _ts_const(text: str, name: str) -> int:
    """The integer value of `export const <name> = <int>;` in `text`. Asserts exactly one
    such declaration so a stray duplicate can't be read past silently."""
    matches = re.findall(rf"export const {name}\s*=\s*(\d+)\s*;", text)
    assert len(matches) == 1, f"expected exactly one `export const {name}` in src/context.tsx, found {len(matches)}"
    return int(matches[0])


def _py_const(text: str, name: str) -> int:
    matches = re.findall(rf"^{name}\s*=\s*(\d+)\s*$", text, re.MULTILINE)
    assert len(matches) == 1, f"expected exactly one `{name} = ...` in lambda_api/constants.py, found {len(matches)}"
    return int(matches[0])


def test_the_parsers_find_the_declared_values():
    # Sanity-guard the regexes so the equality test below can't pass vacuously if a format change
    # makes them match nothing.
    ts = _TS_TWIN.read_text()
    py = _PY_CONSTANTS.read_text()
    assert _ts_const(ts, "SPREAD_MIN_CYCLES") == 1
    assert _ts_const(ts, "SPREAD_MAX_CYCLES") == 24
    assert _py_const(py, "SPREAD_MIN_CYCLES") == 1
    assert _py_const(py, "SPREAD_MAX_CYCLES") == 24


def test_client_and_server_spread_cycle_bounds_are_identical():
    # The client stepper clamp MUST match the server's validation bounds. Change one without the
    # other -> red.
    ts = _TS_TWIN.read_text()
    py = _PY_CONSTANTS.read_text()
    assert _ts_const(ts, "SPREAD_MIN_CYCLES") == _py_const(py, "SPREAD_MIN_CYCLES")
    assert _ts_const(ts, "SPREAD_MAX_CYCLES") == _py_const(py, "SPREAD_MAX_CYCLES")


def test_a_duplicate_ts_declaration_is_rejected_not_read_past():
    # Fail-on-revert for the exactly-one guard: two live declarations must raise, not silently
    # take the first.
    with pytest.raises(AssertionError, match="found 2"):
        _ts_const("export const SPREAD_MIN_CYCLES = 1;\nexport const SPREAD_MIN_CYCLES = 9;\n", "SPREAD_MIN_CYCLES")
