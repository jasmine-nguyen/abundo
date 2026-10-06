"""WHIT-755 slice 1 QA: the shared HTTP fakes keep one home, at any nesting depth."""

import ast
import pathlib

import _anthropic_fakes

_TESTS = pathlib.Path(__file__).resolve().parents[1]
_HOME = _TESTS / "shared" / "_http_fakes.py"


def _other_test_files():
    return [path for path in sorted(_TESTS.rglob("*.py")) if path != _HOME]


def _builds_http_error(node):
    if not isinstance(node, ast.Call):
        return False
    if isinstance(node.func, ast.Attribute):
        return node.func.attr == "HTTPError"
    return isinstance(node.func, ast.Name) and node.func.id == "HTTPError"


# [A1]
def test_no_test_file_builds_its_own_http_error():
    inline = []
    for path in _other_test_files():
        for node in ast.walk(ast.parse(path.read_text())):
            if _builds_http_error(node):
                inline.append(f"{path.relative_to(_TESTS)}:{node.lineno}")
    assert not inline, "use _http_fakes.http_error(code, url=...) instead:\n" + "\n".join(inline)


# [A2]
def test_no_nested_copy_of_the_http_fakes():
    copies = []
    for path in _other_test_files():
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.ClassDef) and node.name in {"FakeResponse", "_FakeResponse"}:
                copies.append(f"{path.relative_to(_TESTS)}:{node.lineno} class {node.name}")
            if isinstance(node, ast.FunctionDef) and node.name in {"http_error", "_http_error"}:
                copies.append(f"{path.relative_to(_TESTS)}:{node.lineno} def {node.name}")
    assert not copies, "import from _http_fakes instead:\n" + "\n".join(copies)


# [A3]
def test_anthropic_fakes_no_longer_carries_fake_response():
    assert not hasattr(_anthropic_fakes, "FakeResponse")
