"""Root test bootstrap — the cross-language marker enforcer (WHIT-436).

A "twin" guard reads a client `src/`/`app/` file and asserts it agrees with a server
value. Those guards must run on ANY client or server change, which the `crosslang` marker
+ the twin-guards.yml CI job arrange. The hole that leaves: a NEW twin guard added without
the marker is invisible to that job and silently skippable — the rot this card kills.

So enforce the marker dynamically. An autouse fixture watches the file-read primitives for
the duration of each test (via ClientReadTracer); if a test read a file under the repo's
`src/`/`app/` trees but is not marked `crosslang`, it fails, naming itself. Dynamic, so it
catches a read made INDIRECTLY through a helper where a source-text scan sees no `src/`
string, and ignores a test that only mentions `src/` in a comment or reads a tmp_path.

Enforcement runs wherever the whole suite runs (the main python-tests job). In the fast
`pytest -m crosslang` drift job only marked tests run, so it is a no-op there.
"""

import pytest

from _crosslang_tracer import ClientReadTracer


@pytest.fixture(autouse=True)
def _crosslang_marker_enforced(request):
    """Fail an unmarked test that reads a client src/ or app/ file (WHIT-436)."""
    with ClientReadTracer() as tracer:
        yield
    if tracer.read_client and request.node.get_closest_marker("crosslang") is None:
        pytest.fail(
            f"{request.node.nodeid} read a client src/ or app/ file but is NOT marked "
            "@pytest.mark.crosslang. Add the marker so the twin-guard CI job "
            "(.github/workflows/twin-guards.yml) runs it on client-only changes — "
            "otherwise a one-sided edit can break it with nothing to catch it.",
            pytrace=False,
        )
