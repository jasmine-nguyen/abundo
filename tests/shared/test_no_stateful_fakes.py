"""WHIT-625 — no hand-written fake anywhere under tests/ copies a database rule.

A fake copies a database rule when it saves data and then reads it back: "already marked → refuse",
"merge into the stored row", "bump the version", "drop the key". Those rules belong to the real
repositories, run over the one stand-in table in ``_dynamo_fakes.py``.

Spies that only record calls (``self.calls.append(...)``) and read-only canned stubs are fine.
"""

import ast
import pathlib

_TESTS = pathlib.Path(__file__).resolve().parent.parent
_STAND_IN_TABLE = _TESTS / "shared" / "_dynamo_fakes.py"

_WRITE_PREFIXES = (
    "mark_", "claim_", "release_", "remove_", "delete_", "clear_", "set_", "update_",
    "create_", "put_", "add_", "settle_", "migrate_", "upsert_", "save_", "record_", "write_",
    "store_", "append_", "increment_", "reset_",
)
_TABLE_WRITES = ("put_item", "update_item", "delete_item")
_MUTATORS = {"pop", "update", "setdefault", "add", "discard", "remove", "clear", "popitem", "insert"}


def _self_attribute(node):
    """The ``x`` of an expression rooted at ``self.x`` (``self.x[k].y``, ``self.x.get(k)``, ...)."""
    while isinstance(node, (ast.Subscript, ast.Attribute, ast.Call)):
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id == "self":
            return node.attr
        node = node.func if isinstance(node, ast.Call) else node.value
    return None


def _is_write(method):
    return method.name.startswith(_WRITE_PREFIXES) or method.name in _TABLE_WRITES


def _mutations(method):
    """(attribute, node) for each in-place change a method makes to a ``self`` container."""
    aliases = {}
    for node in ast.walk(method):
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            attribute = _self_attribute(node.value)
            if attribute:
                aliases[node.targets[0].id] = attribute

    def owner(node):
        if isinstance(node, ast.Name):
            return aliases.get(node.id)
        return _self_attribute(node)

    for node in ast.walk(method):
        targets = []
        if isinstance(node, ast.Assign):
            targets = node.targets
        elif isinstance(node, (ast.AugAssign, ast.AnnAssign)):
            targets = [node.target]
        elif isinstance(node, ast.Delete):
            targets = node.targets
        for target in targets:
            if isinstance(target, ast.Subscript) and owner(target.value):
                yield owner(target.value), target
            if (isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name)
                    and target.value.id == "self"):
                yield target.attr, target
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in _MUTATORS:
            if owner(node.func.value):
                yield owner(node.func.value), node


def _reads(methods, attribute, skipped):
    for method in methods:
        if method.name == "__init__":
            continue
        for node in ast.walk(method):
            if id(node) in skipped:
                continue
            if (isinstance(node, ast.Attribute) and node.attr == attribute
                    and isinstance(node.value, ast.Name) and node.value.id == "self"
                    and isinstance(node.ctx, ast.Load)):
                return True
    return False


def _stateful(cls):
    methods = [item for item in cls.body if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef))]
    saved = {}
    skipped = set()
    for method in methods:
        if not _is_write(method):
            continue
        for attribute, node in _mutations(method):
            saved.setdefault(attribute, set()).add(method.name)
            skipped.update(id(inner) for inner in ast.walk(node))
    return sorted(
        f"{name} → self.{attribute}" for attribute, names in saved.items()
        if _reads(methods, attribute, skipped) for name in sorted(names)
    )


def _stateful_fakes():
    found = []
    for path in sorted(_TESTS.rglob("*.py")):
        if path == _STAND_IN_TABLE:
            continue
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.ClassDef):
                for write in _stateful(node):
                    found.append(f"{path.relative_to(_TESTS)}::{node.name}.{write}")
    return found


def test_no_fake_saves_data_and_reads_it_back():
    found = _stateful_fakes()
    assert found == [], (
        "These hand-written fakes save data and read it back, so they copy a database rule. "
        "Run the real repository over _dynamo_fakes.FakeTable instead:\n  " + "\n  ".join(found)
    )


def _classes(source):
    return [node for node in ast.walk(ast.parse(source)) if isinstance(node, ast.ClassDef)]


def test_a_fake_that_refuses_a_second_mark_is_caught():
    [cls] = _classes(
        "class Notify:\n"
        "    def __init__(self):\n"
        "        self.fired = set()\n"
        "    def mark_fired(self, key):\n"
        "        if key in self.fired:\n"
        "            return False\n"
        "        self.fired.add(key)\n"
        "        return True\n"
    )
    assert _stateful(cls) == ["mark_fired → self.fired"]


def test_a_fake_that_serves_saved_rows_back_is_caught():
    [cls] = _classes(
        "class Budgets:\n"
        "    def __init__(self):\n"
        "        self.rows = {}\n"
        "    def set_budget(self, key, amount):\n"
        "        row = self.rows.setdefault(key, {})\n"
        "        row['amount'] = amount\n"
        "    def list_budgets(self):\n"
        "        return list(self.rows.values())\n"
    )
    assert _stateful(cls) == ["set_budget → self.rows"]


def test_a_fake_that_overwrites_a_saved_value_and_reads_it_back_is_caught():
    [cls] = _classes(
        "class Refresh:\n"
        "    def __init__(self):\n"
        "        self._last = None\n"
        "    def set_last_refresh_at(self, at):\n"
        "        self._last = at\n"
        "    def get_last_refresh_at(self):\n"
        "        return self._last\n"
    )
    assert _stateful(cls) == ["set_last_refresh_at → self._last"]


def test_a_spy_that_only_records_calls_passes():
    [cls] = _classes(
        "class Spy:\n"
        "    def __init__(self):\n"
        "        self.calls = []\n"
        "        self.last = {}\n"
        "    def mark_fired(self, key):\n"
        "        self.calls.append(key)\n"
        "        self.last[key] = True\n"
        "        self.last_key = key\n"
        "        return True\n"
        "    def list_things(self):\n"
        "        return []\n"
    )
    assert _stateful(cls) == []
