"""WHIT-477: guard that the goal-checkpoint caps stay in sync between client and server.

`CHECKPOINT_MAX_COUNT` / `CHECKPOINT_LABEL_MAX_LEN` / `CHECKPOINT_AMOUNT_MAX` in
src/checkpoints.ts are the same rules as `_GOAL_CHECKPOINT_MAX_COUNT` /
`_GOAL_CHECKPOINT_LABEL_MAX_LEN` / `_GOAL_AMOUNT_MAX` in lambda_api/handler.py, written
twice — the client blocks a bad ladder with a friendly message before saving, the server
rejects it again on the way in. A one-sided edit drifts silently: the client either blocks
ladders the server would accept, or waves through ones the server 400s on.

Same shape as test_milestone_cap_sync.py: read the client `const NAME = <number>` through
the shared reader in tests/shared/_ts_const.py; read the server value through the `handler`
fixture (handler.py has real imports, so it can't be exec'd standalone).
"""

import pathlib

import pytest

import _ts_const

pytestmark = pytest.mark.crosslang

_ROOT = pathlib.Path(__file__).resolve().parents[2]
_CLIENT_CHECKPOINTS = _ROOT / "src" / "checkpoints.ts"

# (client const, server handler attribute, pinned value) — the amount cap is shared with the
# goal target cap on the server, so it's a live edit target and pinned like the others.
_CAPS = [
    ("CHECKPOINT_MAX_COUNT", "_GOAL_CHECKPOINT_MAX_COUNT", 20),
    ("CHECKPOINT_LABEL_MAX_LEN", "_GOAL_CHECKPOINT_LABEL_MAX_LEN", 100),
    ("CHECKPOINT_AMOUNT_MAX", "_GOAL_AMOUNT_MAX", 1_000_000_000),
]


def _client_cap(name: str) -> int:
    return _ts_const.number_const(_CLIENT_CHECKPOINTS.read_text(), name)


@pytest.mark.parametrize("client_name, _server_attr, _value", _CAPS)
def test_client_cap_parses_to_a_positive_int(client_name, _server_attr, _value):
    """Sanity-guard the parser: a renamed/removed const matches nothing and would let the
    equality test below pass vacuously — fail here with a clear 'update the parser' signal."""
    assert _client_cap(client_name) > 0


@pytest.mark.parametrize("client_name, _server_attr, _value", _CAPS)
def test_exactly_one_client_cap_declaration(client_name, _server_attr, _value):
    """The parser takes the FIRST match, so a shadowing second declaration (a commented-out
    old value above the live line) would be compared instead."""
    _ts_const.assert_one_number_const(_CLIENT_CHECKPOINTS.read_text(), client_name)


@pytest.mark.parametrize("client_name, server_attr, value", _CAPS)
def test_the_checkpoint_cap_value_is_pinned(handler, client_name, server_attr, value):
    """The two sides only have to AGREE — lower both in lockstep and everything stays green
    while the editor silently refuses ladders it used to take. This pins the value itself.

    If you are deliberately changing a cap, this is the ONE test that should go red."""
    server = getattr(handler, server_attr)
    assert isinstance(server, int) and server == value, (
        f"{server_attr} is now {server!r}, not {value} — if you meant to change it, update "
        f"this pin and src/checkpoints.ts too; if you didn't, this is the typo it exists to catch."
    )


@pytest.mark.parametrize("client_name, server_attr, _value", _CAPS)
def test_client_and_server_checkpoint_caps_agree(handler, client_name, server_attr, _value):
    """Change one side without the other -> red."""
    client = _client_cap(client_name)
    server = getattr(handler, server_attr)
    assert client == server, (
        f"checkpoint cap drift: src/checkpoints.ts {client_name} is {client} but "
        f"lambda_api/handler.py {server_attr} is {server} — update both to the same value"
    )
