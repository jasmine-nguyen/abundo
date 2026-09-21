"""WHIT-436 — the crosslang marker tracer (_crosslang_tracer) boundary + restore (QA gaps).

The implementer proved the enforcer fails an unmarked reader end-to-end (fail-on-revert).
It did NOT pin the tracer's decision boundary, its detection of a read made through each
patched primitive, or that it restores those primitives even when a test raised. Those are
the highest-risk lines: a false NEGATIVE lets a new twin guard rot unmarked (the exact rot
this card kills); a false POSITIVE fails an honest test; a botched restore silently poisons
every following test's file I/O.

Everything drives the REAL `_is_client_read` / `ClientReadTracer`, never a re-implementation.
"""

import builtins
import os
import pathlib

import pytest

from _crosslang_tracer import ClientReadTracer, _REPO_ROOT, _is_client_read

# Several tests below read the real src/chartColors.ts to prove the tracer detects it, so
# by the enforcer's own rule this file is a client-file reader and carries the marker. It
# also means these tests run in the drift job whenever the tracer itself changes.
pytestmark = pytest.mark.crosslang

_CLIENT_FILE = _REPO_ROOT / "src" / "chartColors.ts"
_SHARED_FILE = _REPO_ROOT / "shared" / "repository_category.py"


# --------------------------------------------------------------- _is_client_read boundary
# Pure predicate: passes path VALUES, opens nothing, so these need no marker.


def test_absolute_path_under_src_is_a_client_read():
    assert _is_client_read(str(_REPO_ROOT / "src" / "chartColors.ts")) is True


def test_absolute_path_under_app_is_a_client_read():
    # the ramp file has lived under app/ before (WHIT-408); app/ must count too.
    assert _is_client_read(str(_REPO_ROOT / "app" / "_layout.tsx")) is True


def test_a_path_object_under_src_is_a_client_read():
    # os.fspath must accept a real Path, not just a str.
    assert _is_client_read(_REPO_ROOT / "src" / "theme.ts") is True


def test_shared_path_is_not_a_client_read():
    assert _is_client_read(str(_SHARED_FILE)) is False


def test_tests_path_is_not_a_client_read():
    # a guard reading its own fixture under tests/ must not self-trip.
    assert _is_client_read(str(_REPO_ROOT / "tests" / "shared" / "_chart_ramp.py")) is False


def test_a_tmp_path_is_not_a_client_read():
    # monkeypatched tmp_path fixtures (the parser-edge tests) must stay unmarked.
    assert _is_client_read("/tmp/whatever/src/chartColors.ts") is False


def test_an_integer_fd_is_not_a_client_read():
    # open() can be handed a raw fd; it is not a path and must not trip the tracer.
    assert _is_client_read(5) is False


def test_bytes_path_under_src_is_a_client_read():
    # open() accepts bytes paths; a bytes path under src/ is still a client read.
    assert _is_client_read(os.fsencode(str(_REPO_ROOT / "src" / "chartColors.ts"))) is True


def test_bytes_path_under_shared_is_not_a_client_read():
    # the bytes branch must still respect the src/app boundary, not match everything.
    assert _is_client_read(os.fsencode(str(_SHARED_FILE))) is False


def test_a_sibling_dir_sharing_the_src_prefix_is_not_a_client_read():
    # `<root>/srcextra/x.ts` shares the text prefix "src" but is NOT under src/. Pins the
    # `+ os.sep` in _CLIENT_PREFIXES; drop it and this reddens.
    assert _is_client_read(str(_REPO_ROOT / "srcextra" / "x.ts")) is False


def test_a_repo_root_file_is_not_a_client_read():
    assert _is_client_read(str(_REPO_ROOT / "description.txt")) is False


def test_a_non_path_like_object_is_not_a_client_read():
    # os.fspath(object()) raises TypeError; the guard must swallow it, not explode.
    assert _is_client_read(object()) is False


# ----------------------------------------------------- ClientReadTracer detects each read
# Each drives the real context manager and asserts it recorded (or ignored) the read.


def test_a_builtins_open_read_of_a_client_file_is_detected():
    # a guard reading via builtins.open (not Path.read_text) must still be caught.
    with ClientReadTracer() as tracer:
        with open(str(_CLIENT_FILE)) as handle:
            handle.read()
    assert tracer.read_client is True


def test_a_path_read_text_of_a_client_file_is_detected():
    # End-to-end: the way every current guard reads its twin. On CPython read_text delegates
    # to Path.open, so the dedicated read_text patch is cross-version insurance rather than
    # this test's sole line of defence — it proves the read is caught, not which patch caught it.
    with ClientReadTracer() as tracer:
        _CLIENT_FILE.read_text()
    assert tracer.read_client is True


def test_a_path_read_bytes_of_a_client_file_is_detected():
    # Same: read_bytes also delegates to Path.open on CPython, so this proves end-to-end
    # detection; the dedicated read_bytes patch guards interpreters/refactors where it doesn't.
    with ClientReadTracer() as tracer:
        _CLIENT_FILE.read_bytes()
    assert tracer.read_client is True


def test_a_path_open_of_a_client_file_is_detected():
    with ClientReadTracer() as tracer:
        with _CLIENT_FILE.open() as handle:
            handle.read()
    assert tracer.read_client is True


def test_reading_only_a_shared_file_is_not_detected():
    # the SERVER side of a twin is not a client read — else every ordinary test would trip.
    with ClientReadTracer() as tracer:
        _SHARED_FILE.read_text()
    assert tracer.read_client is False


# ------------------------------------------------------------------ restore on exit/raise


def test_the_tracer_restores_primitives_after_a_clean_run():
    before = (builtins.open, pathlib.Path.read_text, pathlib.Path.read_bytes, pathlib.Path.open)
    with ClientReadTracer():
        assert builtins.open is not before[0]  # sanity: the trace really was installed
    assert (builtins.open, pathlib.Path.read_text, pathlib.Path.read_bytes,
            pathlib.Path.open) == before


def test_the_tracer_restores_primitives_even_when_the_body_raised():
    # The restore lives in __exit__; if it regressed to a success-only path, a raising test
    # would leak the traced primitives into every later test. Prove it survives an exception.
    before = (builtins.open, pathlib.Path.read_text, pathlib.Path.read_bytes, pathlib.Path.open)
    try:
        with ClientReadTracer():
            raise RuntimeError("boom from the test body")
    except RuntimeError:
        pass
    assert (builtins.open, pathlib.Path.read_text, pathlib.Path.read_bytes,
            pathlib.Path.open) == before
