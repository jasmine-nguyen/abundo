"""WHIT-393: guard that the milestone balance cap stays in sync between client and server.

`_MILESTONE_BALANCE_MAX` in lambda_api/handler.py and `MILESTONE_BALANCE_MAX` in
src/milestones.ts are the same rule written twice — the client rejects an out-of-range
target balance before saving, the server rejects it again on the way in. Nothing proved
they agree. A one-sided edit drifts silently: the client either blocks balances the
server would accept, or waves through balances the server 400s on.

Same shape as the loan-facts guard (test_loanfacts_ceiling_sync.py): both read the
client `const NAME = <number>` through the shared reader in tests/shared/_ts_const.py.
One difference — the server value lives in handler.py, which has real imports, so it is
read through the `handler` fixture rather than exec'd.

tests/shared/test_milestones_twin_drift.py is a different guard: it compares the
milestone PLAN rows across the two twins, not this cap.
"""

import pathlib

import pytest

import _ts_const

pytestmark = pytest.mark.crosslang

_ROOT = pathlib.Path(__file__).resolve().parents[2]
_CLIENT_MILESTONES = _ROOT / "src" / "milestones.ts"


def _client_cap() -> int:
    """The MILESTONE_BALANCE_MAX const parsed out of src/milestones.ts."""
    return _ts_const.number_const(_CLIENT_MILESTONES.read_text(), "MILESTONE_BALANCE_MAX")


def test_client_cap_parses_to_a_positive_int():
    """Sanity-guard the parser: if the declaration is renamed or removed so the regex
    matches nothing, fail here with a clear 'update the parser' signal rather than
    letting the equality test below pass vacuously."""
    assert _client_cap() > 0


def test_exactly_one_client_cap_declaration():
    """The parser takes the FIRST match, so a shadowing second declaration (a
    commented-out old value above the live line) would be compared instead."""
    _ts_const.assert_one_number_const(_CLIENT_MILESTONES.read_text(), "MILESTONE_BALANCE_MAX")


def test_the_milestone_cap_value_is_pinned(handler):
    """The two sides only have to AGREE — lower both in lockstep and everything stays
    green while the editor silently refuses balances it used to take. This pins the value
    itself, as its siblings do (test_loanfacts_ceiling_sync.py, test_goals_gaps.py).

    If you are deliberately changing the cap, this is the ONE test that should go red."""
    cap = handler._MILESTONE_BALANCE_MAX
    assert isinstance(cap, int) and cap == 1_000_000_000, (
        f"the milestone balance cap is now {cap!r}, not 1_000_000_000 — if you meant to "
        "change it, update this pin and src/milestones.ts too; if you didn't, this is the "
        "typo it exists to catch. It must stay an int: a float would read as '1000000000.0'."
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
