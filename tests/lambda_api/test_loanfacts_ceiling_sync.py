"""WHIT-392: guard that the loan form's client dollar ceiling stays in sync
with the server's LOANFACTS_FIELD_MAX.

The client (`src/loanLimits.ts`, used by the loan form) hand-mirrors the server's
field ceiling so it can block a too-large amount with a friendly message before any
round-trip. The authoritative value lives in `lambda_api/api_constants.py`
(LOANFACTS_FIELD_MAX); the client copy is a plain `const` in a TypeScript file.
Nothing proved the two agree — this constant lives only in lambda_api, so a
one-sided change would drift silently (client wrongly blocks valid amounts, or wrongly allows
too-large ones).

This reads BOTH values and asserts they match, so editing one side without the
other fails loudly. It parses the TypeScript client as TEXT (no JS runtime in
the pytest suite) via the shared `const NAME = <number>` reader in
tests/shared/_ts_const.py — the same reader the milestone-cap guard uses.
"""

import pathlib

import pytest

import _ts_const
from _lambda_api_constants import api_constant

pytestmark = pytest.mark.crosslang

_ROOT = pathlib.Path(__file__).resolve().parents[2]
_CLIENT_LIMITS = _ROOT / "src" / "loanLimits.ts"


def _server_ceiling() -> int:
    """LOANFACTS_FIELD_MAX from lambda_api/api_constants.py. The read lives in
    tests/shared/_lambda_api_constants.py (WHIT-393) so this guard and the
    loan-facts edges suite share one reader."""
    return api_constant("LOANFACTS_FIELD_MAX")


def _client_ceiling() -> int:
    """The LOANFACTS_FIELD_MAX const parsed out of src/loanLimits.ts."""
    text = _CLIENT_LIMITS.read_text()
    _ts_const.assert_one_number_const(text, "LOANFACTS_FIELD_MAX")
    return _ts_const.number_const(text, "LOANFACTS_FIELD_MAX")


def test_client_and_server_loanfacts_ceilings_agree():
    """The loan form's ceiling and the server's LOANFACTS_FIELD_MAX must match.
    Change one without the other -> red."""
    client = _client_ceiling()
    server = _server_ceiling()
    assert client == server, (
        f"loan-facts ceiling drift: src/loanLimits.ts has {client} but "
        f"lambda_api/api_constants.py LOANFACTS_FIELD_MAX is {server} — "
        "update both to the same value"
    )
