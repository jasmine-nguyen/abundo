"""WHIT-392: guard that the loan form's client dollar ceiling stays in sync
with the server's LOANFACTS_FIELD_MAX.

The loan form (`app/loan.tsx`) hand-mirrors the server's field ceiling so it can
block a too-large amount with a friendly message before any round-trip. The
authoritative value lives in `lambda_api/constants.py` (LOANFACTS_FIELD_MAX);
the client copy is a plain `const` in a `.tsx` file. Nothing proved the two
agree — the WHIT-136 sync test only covers names the shared layer imports, and
this constant lives only in lambda_api, so a one-sided change would drift
silently (client wrongly blocks valid amounts, or wrongly allows too-large ones).

This reads BOTH values and asserts they match, so editing one side without the
other fails loudly. It parses the TypeScript client as TEXT (no JS runtime in
the pytest suite) via a simple regex over the `const LOANFACTS_FIELD_MAX = ...`
declaration — same approach as tests/shared/test_milestones_twin_drift.py.

WHIT-393 added one more assertion here: a pin on the ceiling's actual VALUE.
Every test mirror now derives from lambda_api/constants.py, so without the pin
a typo in that file would ship green.
"""

import pathlib
import re

from _lambda_api_constants import api_constant

_ROOT = pathlib.Path(__file__).resolve().parents[2]
_CLIENT_LOAN_FORM = _ROOT / "app" / "loan.tsx"

# The client declaration, e.g. `const LOANFACTS_FIELD_MAX = 1_000_000_000;`. Anchored on
# `const` so a mention of the name in a comment can't match — `export const ...` still does.
_CLIENT_CEILING = re.compile(r"const\s+LOANFACTS_FIELD_MAX\s*=\s*([\d_]+)")


def _server_ceiling() -> int:
    """LOANFACTS_FIELD_MAX from lambda_api/constants.py. The read lives in
    tests/shared/_lambda_api_constants.py (WHIT-393) so this guard and the
    loan-facts edges suite share one reader."""
    return api_constant("LOANFACTS_FIELD_MAX")


def _client_ceiling() -> int:
    """The LOANFACTS_FIELD_MAX const parsed out of app/loan.tsx."""
    match = _CLIENT_CEILING.search(_CLIENT_LOAN_FORM.read_text())
    assert match, "could not locate `const LOANFACTS_FIELD_MAX = ...` in app/loan.tsx"
    return int(match.group(1).replace("_", ""))


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
    matches = _CLIENT_CEILING.findall(_CLIENT_LOAN_FORM.read_text())
    assert len(matches) == 1, (
        f"expected exactly one `const LOANFACTS_FIELD_MAX = <number>` in "
        f"app/loan.tsx, found {len(matches)}: {matches} — a shadowing/commented "
        "copy makes the sync guard compare the wrong (first-matched) value"
    )


def test_the_loanfacts_ceiling_value_is_pinned():
    """WHIT-393 made every test mirror derive from lambda_api/constants.py, so nothing
    else asserts the ceiling's actual VALUE any more — a typo there (1_000_000 for
    1_000_000_000) would leave the whole suite green while the app silently rejected
    normal loan amounts. This is the one deliberate pin: changing the ceiling should
    cost exactly one honest edit, here."""
    assert _server_ceiling() == 1_000_000_000, (
        f"the loan-facts ceiling is now {_server_ceiling()}, not 1_000_000_000 — if you "
        "meant to change it, update this pin too; if you didn't, this is the typo it exists "
        "to catch. Remember the toast copy is generated, so check how the new figure reads."
    )


def test_client_and_server_loanfacts_ceilings_agree():
    """The loan form's ceiling and the server's LOANFACTS_FIELD_MAX must match.
    Change one without the other -> red."""
    client = _client_ceiling()
    server = _server_ceiling()
    assert client == server, (
        f"loan-facts ceiling drift: app/loan.tsx has {client} but "
        f"lambda_api/constants.py LOANFACTS_FIELD_MAX is {server} — "
        "update both to the same value"
    )
