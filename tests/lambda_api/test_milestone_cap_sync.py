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


def test_client_and_server_milestone_caps_agree(handler):
    """Change one side without the other -> red."""
    client = _client_cap()
    server = handler._MILESTONE_BALANCE_MAX
    assert client == server, (
        f"milestone balance cap drift: src/milestones.ts has {client} but "
        f"lambda_api/handler.py _MILESTONE_BALANCE_MAX is {server} — "
        "update both to the same value"
    )
