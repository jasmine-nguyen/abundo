"""WHIT-784: the pending-mirror test setup lives once.

Fixtures (layer / repo / mirror) live in tests/sync_trigger/conftest.py; plain helpers
and constants live in tests/shared/_pending_mirror_fakes.py. No sync_trigger test file
keeps its own copy again.
"""

import pathlib
import re

_TESTS = pathlib.Path(__file__).resolve().parents[1]
_SYNC_TRIGGER_TESTS = _TESTS / "sync_trigger"


def test_no_sync_trigger_test_keeps_its_own_pending_mirror_setup():
    local_copy = re.compile(
        r"^\s*_SHARED_MODULES\b|"
        r"^\s*WESTPAC_AID\s*=|"
        r"^\s*def (layer|_fetch_returning|_stored)\(",
        re.M)
    offenders = sorted(
        path.name
        for path in _SYNC_TRIGGER_TESTS.glob("test_*.py")
        if local_copy.search(path.read_text())
    )
    assert offenders == [], (
        "use the conftest layer fixture and import from _pending_mirror_fakes instead: "
        f"{offenders}")
