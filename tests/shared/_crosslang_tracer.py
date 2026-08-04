"""Client-file read tracer for the crosslang marker enforcer (WHIT-436).

A "twin" guard reads a client `src/`/`app/` file and asserts it agrees with a server
value; it must carry the `crosslang` marker so the twin-guards.yml CI job runs it on a
one-sided edit. The root tests/conftest.py uses this tracer to FAIL an unmarked test that
actually read a client file — enforcing marker completeness dynamically, so it catches a
read made INDIRECTLY through a helper (_chart_ramp, _ts_const) that a source-text scan
would miss.

Lives in tests/shared (on pytest's pythonpath) rather than inside the root conftest so the
enforcement logic is importable and unit-testable on its own.

Scope of detection: it watches the read primitives the guards actually use —
`pathlib.Path.read_text` / `.read_bytes` / `.open` and `builtins.open`. A read via some
other API (`os.open`, a subprocess, a C extension) is not seen; this is a backstop for the
common case, not a sandbox. All current guards read via these primitives.
"""

import builtins
import os
import pathlib

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
# A read under either of these absolute trees is a client-source read. `realpath` (not
# `abspath`) so a symlinked checkout resolves to the same tree _REPO_ROOT was resolved to.
_CLIENT_PREFIXES = tuple(str(_REPO_ROOT / directory) + os.sep for directory in ("src", "app"))


def _is_client_read(target) -> bool:
    """True if `target` (a path handed to open/read_text) resolves under src/ or app/."""
    if isinstance(target, int):        # a raw file descriptor, not a path
        return False
    try:
        raw = os.fspath(target)
    except TypeError:
        return False
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", "ignore")
    return os.path.realpath(raw).startswith(_CLIENT_PREFIXES)


class ClientReadTracer:
    """Context manager that records whether a client src/ or app/ file was read while active.

    Patches the read primitives on enter and restores them on exit (including on an
    exception), so it never leaks a wrapped primitive into a later test.
    """

    def __init__(self):
        self.read_client = False

    def __enter__(self):
        self._originals = (
            pathlib.Path.read_text, pathlib.Path.read_bytes, pathlib.Path.open, builtins.open,
        )
        real_read_text, real_read_bytes, real_path_open, real_open = self._originals

        def traced_read_text(path, *args, **kwargs):
            if _is_client_read(path):
                self.read_client = True
            return real_read_text(path, *args, **kwargs)

        def traced_read_bytes(path, *args, **kwargs):
            if _is_client_read(path):
                self.read_client = True
            return real_read_bytes(path, *args, **kwargs)

        def traced_path_open(path, *args, **kwargs):
            if _is_client_read(path):
                self.read_client = True
            return real_path_open(path, *args, **kwargs)

        def traced_open(file, *args, **kwargs):
            if _is_client_read(file):
                self.read_client = True
            return real_open(file, *args, **kwargs)

        pathlib.Path.read_text = traced_read_text
        pathlib.Path.read_bytes = traced_read_bytes
        pathlib.Path.open = traced_path_open
        builtins.open = traced_open
        return self

    def __exit__(self, *exc):
        (pathlib.Path.read_text, pathlib.Path.read_bytes,
         pathlib.Path.open, builtins.open) = self._originals
        return False
