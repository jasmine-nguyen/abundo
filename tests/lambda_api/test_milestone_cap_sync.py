"""WHIT-393: guard that the milestone balance cap stays in sync between client and server.

`_MILESTONE_BALANCE_MAX` in lambda_api/handler.py and `MILESTONE_BALANCE_MAX` in
src/milestones.ts are the same rule written twice — the client rejects an out-of-range
target balance before saving, the server rejects it again on the way in. Nothing proved
they agree. A one-sided edit drifts silently: the client either blocks balances the
server would accept, or waves through balances the server 400s on.

Same shape as the loan-facts guard (test_loanfacts_ceiling_sync.py), with one
difference — the server value lives in handler.py, which has real imports, so it is read
through the `handler` fixture rather than exec'd.

tests/shared/test_milestones_twin_drift.py is a different guard: it compares the
milestone PLAN rows across the two twins, not this cap.
"""

import pathlib
import re

_ROOT = pathlib.Path(__file__).resolve().parents[2]
_CLIENT_MILESTONES = _ROOT / "src" / "milestones.ts"

# e.g. `export const MILESTONE_BALANCE_MAX = 1_000_000_000;`. Anchored on `const` so a
# mention of the name in a comment can't match.
_CLIENT_CAP = re.compile(r"const\s+MILESTONE_BALANCE_MAX\s*=\s*([\d_]+)")


def _client_cap() -> int:
    """The MILESTONE_BALANCE_MAX const parsed out of src/milestones.ts."""
    match = _CLIENT_CAP.search(_CLIENT_MILESTONES.read_text())
    assert match, "could not locate `const MILESTONE_BALANCE_MAX = ...` in src/milestones.ts"
    return int(match.group(1).replace("_", ""))


def test_client_cap_parses_to_a_positive_int():
    """Sanity-guard the parser: if the declaration is renamed or removed so the regex
    matches nothing, fail here with a clear 'update the parser' signal rather than
    letting the equality test below pass vacuously."""
    assert _client_cap() > 0


def test_exactly_one_client_cap_declaration():
    """The parser takes the FIRST match, so a shadowing second declaration (a
    commented-out old value above the live line) would be compared instead."""
    matches = _CLIENT_CAP.findall(_CLIENT_MILESTONES.read_text())
    assert len(matches) == 1, (
        f"expected exactly one `const MILESTONE_BALANCE_MAX = <number>` in "
        f"src/milestones.ts, found {len(matches)}: {matches} — a shadowing/commented "
        "copy makes this guard compare the wrong (first-matched) value"
    )


def test_client_and_server_milestone_caps_agree(handler):
    """Change one side without the other -> red."""
    client = _client_cap()
    server = handler._MILESTONE_BALANCE_MAX
    assert client == server, (
        f"milestone balance cap drift: src/milestones.ts has {client} but "
        f"lambda_api/handler.py _MILESTONE_BALANCE_MAX is {server} — "
        "update both to the same value"
    )
