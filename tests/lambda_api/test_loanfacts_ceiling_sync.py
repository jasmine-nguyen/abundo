"""WHIT-392: guard that the loan form's client dollar ceiling stays in sync
with the server's LOANFACTS_FIELD_MAX.

The client (`src/loanLimits.ts`, used by the loan form) hand-mirrors the server's
field ceiling so it can block a too-large amount with a friendly message before any
round-trip. The authoritative value lives in `lambda_api/constants.py`
(LOANFACTS_FIELD_MAX); the client copy is a plain `const` in a TypeScript file.
Nothing proved the two agree — the WHIT-136 sync test only covers names the shared
layer imports, and this constant lives only in lambda_api, so a one-sided change
would drift silently (client wrongly blocks valid amounts, or wrongly allows
too-large ones).

This reads BOTH values and asserts they match, so editing one side without the
other fails loudly. It parses the TypeScript client as TEXT (no JS runtime in
the pytest suite) via the shared `const NAME = <number>` reader in
tests/shared/_ts_const.py — the same reader the milestone-cap guard uses.

WHIT-393 added one more assertion here: a pin on the ceiling's actual VALUE.
Every test mirror now derives from lambda_api/constants.py, so without the pin
a typo in that file would ship green.
"""

import pathlib

import pytest

import _ts_const
from _lambda_api_constants import api_constant

pytestmark = pytest.mark.crosslang

_ROOT = pathlib.Path(__file__).resolve().parents[2]
_CLIENT_LIMITS = _ROOT / "src" / "loanLimits.ts"


def _server_ceiling() -> int:
    """LOANFACTS_FIELD_MAX from lambda_api/constants.py. The read lives in
    tests/shared/_lambda_api_constants.py (WHIT-393) so this guard and the
    loan-facts edges suite share one reader."""
    return api_constant("LOANFACTS_FIELD_MAX")


def _client_ceiling() -> int:
    """The LOANFACTS_FIELD_MAX const parsed out of src/loanLimits.ts."""
    return _ts_const.number_const(_CLIENT_LIMITS.read_text(), "LOANFACTS_FIELD_MAX")


def test_client_ceiling_parses_to_a_positive_int():
    """Sanity-guard the parser itself: if the client declaration is renamed or
    removed so this regex matches nothing, `_client_ceiling` fails here with a
    clear 'update the parser' signal rather than letting the equality test below
    pass vacuously."""
    assert _client_ceiling() > 0


def test_exactly_one_client_ceiling_declaration():
    """`_client_ceiling` takes the FIRST regex match, so a shadowing second
    `const LOANFACTS_FIELD_MAX = <number>` (e.g. a commented-out old value left
    above the live line) would silently be compared instead — and could hide a
    real drift if it happened to equal the server. Pin exactly one declaration."""
    _ts_const.assert_one_number_const(_CLIENT_LIMITS.read_text(), "LOANFACTS_FIELD_MAX")


def test_the_loanfacts_ceiling_value_is_pinned():
    """WHIT-393 made every test mirror derive from lambda_api/constants.py, so nothing
    else asserts the ceiling's actual VALUE any more — a typo there (1_000_000 for
    1_000_000_000) would leave the whole suite green while the app silently rejected
    normal loan amounts. This is the one deliberate pin: changing the ceiling should
    cost exactly one honest edit, here.

    Note for anyone temporarily changing the ceiling to check the mirrors follow it:
    this test is the ONE that should go red, and only this one. Anything else red is a
    real failure. Update the pin, don't delete it."""
    ceiling = _server_ceiling()
    assert isinstance(ceiling, int) and ceiling == 1_000_000_000, (
        f"the loan-facts ceiling is now {ceiling!r}, not 1_000_000_000 — if you meant to "
        "change it, update this pin too; if you didn't, this is the typo it exists to catch. "
        "It must stay an int: the toast copy is generated from it, and a float would read "
        "'$1000000000.5' rather than '$1B'."
    )


def test_client_and_server_loanfacts_ceilings_agree():
    """The loan form's ceiling and the server's LOANFACTS_FIELD_MAX must match.
    Change one without the other -> red."""
    client = _client_ceiling()
    server = _server_ceiling()
    assert client == server, (
        f"loan-facts ceiling drift: src/loanLimits.ts has {client} but "
        f"lambda_api/constants.py LOANFACTS_FIELD_MAX is {server} — "
        "update both to the same value"
    )
