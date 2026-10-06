"""WHIT-755 slice 1: one shared fake bank reply (FakeResponse) and fake HTTP error (http_error).

  * the shared fakes in tests/shared/_http_fakes.py behave like the copies they replace;
  * no server test file keeps its own copy — every suite imports the shared one.
"""

import ast
import pathlib
import urllib.error

_TESTS = pathlib.Path(__file__).resolve().parents[1]                 # tests/
_HOME = _TESTS / "shared" / "_http_fakes.py"
_COPY_CLASSES = {"FakeResponse", "_FakeResponse"}
_COPY_FUNCTIONS = {"http_error", "_http_error"}


def test_fake_bank_reply_and_error_come_from_one_shared_module():
    from _http_fakes import FakeResponse, http_error

    with FakeResponse({"data": {"id": "job-1"}}) as response:
        assert response.read() == b'{"data": {"id": "job-1"}}'
    assert FakeResponse().read() == b""
    assert FakeResponse(None).read() == b""
    assert FakeResponse({}).__exit__(None, None, None) is False

    error = http_error(401)
    assert isinstance(error, urllib.error.HTTPError)
    assert error.code == 401
    assert error.url == "https://api.banksync.io/x"
    assert error.read() == b""

    up_error = http_error(500, url="https://api.up.com.au/x")
    assert up_error.code == 500
    assert up_error.url == "https://api.up.com.au/x"


def test_no_server_test_file_keeps_its_own_copy_of_the_http_fakes():
    copies = []
    for path in sorted(_TESTS.rglob("*.py")):
        if path == _HOME:
            continue
        for node in ast.parse(path.read_text()).body:
            if isinstance(node, ast.ClassDef) and node.name in _COPY_CLASSES:
                copies.append(f"{path.relative_to(_TESTS)}:{node.lineno} class {node.name}")
            if isinstance(node, ast.FunctionDef) and node.name in _COPY_FUNCTIONS:
                copies.append(f"{path.relative_to(_TESTS)}:{node.lineno} def {node.name}")
    assert not copies, "import FakeResponse / http_error from _http_fakes instead:\n" + "\n".join(copies)
