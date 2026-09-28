"""WHIT-625 QA (slice 3 fix round) — the "no stateful fake" guard and the FakeTable page cut.

The guard in test_no_stateful_fakes.py is the card's "Done when: no hand-written repository fake
copies a database rule". These cases pin what it must catch, including the shape it missed:
a write that edits a saved row it found by looping over ``self.<rows>``.
"""

import ast

from _dynamo_fakes import FakeTable
from _boto_stubs import _Field
from test_no_stateful_fakes import _stateful, _stateful_fakes


def _cls(source):
    [cls] = [node for node in ast.walk(ast.parse(source)) if isinstance(node, ast.ClassDef)]
    return cls


def test_a_fake_that_flips_a_saved_row_found_by_a_loop_is_caught():
    # [A1] tests/lambda/test_rule_ingest_spread*.py FakeRuleStore has exactly this shape: it copies
    # production's "mark_spread_seeded flips the stored row" rule and a later list_rules reads it back.
    cls = _cls(
        "class RuleStore:\n"
        "    def __init__(self, rules):\n"
        "        self._rules = [dict(r) for r in rules]\n"
        "    def list_rules(self):\n"
        "        return [dict(r) for r in self._rules]\n"
        "    def mark_spread_seeded(self, rule_id):\n"
        "        for row in self._rules:\n"
        "            if row['id'] == rule_id:\n"
        "                row['spread_seeded'] = True\n"
    )
    assert _stateful(cls) == ["mark_spread_seeded → self._rules"]


def test_no_rule_store_fake_under_tests_flips_spread_seeded():
    # [A2] The tree-wide guard must not pass while the rule-ingest FakeRuleStore copies the rule.
    found = [entry for entry in _stateful_fakes() if "FakeRuleStore" in entry]
    assert found == [] and not _rule_store_fakes_remain(), (
        "FakeRuleStore still saves spread_seeded and reads it back — run the real "
        "RuleRepository over FakeTable instead"
    )


def _rule_store_fakes_remain():
    import pathlib

    tests = pathlib.Path(__file__).resolve().parent.parent
    remaining = []
    for path in sorted((tests / "lambda").glob("test_rule_ingest_spread*.py")):
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.ClassDef) and any(
                    isinstance(item, ast.FunctionDef) and item.name == "mark_spread_seeded"
                    and any(isinstance(inner, ast.For) for inner in ast.walk(item))
                    for item in node.body):
                remaining.append(f"{path.name}::{node.name}")
    return remaining


def test_a_saved_value_changed_through_an_alias_update_call_is_caught():
    # [A3] ``row = self.rows[key]`` then ``row.update(...)`` is still a save.
    cls = _cls(
        "class Budgets:\n"
        "    def __init__(self):\n"
        "        self.rows = {}\n"
        "    def set_budget(self, key, fields):\n"
        "        row = self.rows[key]\n"
        "        row.update(fields)\n"
        "    def get_budget(self, key):\n"
        "        return self.rows.get(key)\n"
    )
    assert _stateful(cls) == ["set_budget → self.rows"]


def test_a_write_only_log_read_back_only_in_init_passes():
    # [A4] A set only __init__ reads (a write-only record for the test) must not be flagged.
    cls = _cls(
        "class Spy:\n"
        "    def __init__(self, seed=()):\n"
        "        self.marked = set()\n"
        "        self.marked.update(seed)\n"
        "    def mark_spread_seeded(self, rule_id):\n"
        "        self.marked.add(rule_id)\n"
    )
    assert _stateful(cls) == []


def _rows(table):
    table.seed(
        {"pk": "P", "sk": "a", "status": "POSTED"},
        {"pk": "P", "sk": "b", "status": "PENDING"},
        {"pk": "P", "sk": "c", "status": "PENDING"},
        {"pk": "P", "sk": "d", "status": "PENDING"},
    )


def test_page_size_without_a_filter_pages_through_every_row_once():
    # [A5] Following LastEvaluatedKey page by page returns each key-matched row exactly once.
    table = FakeTable()
    _rows(table)
    table.page_size = 3
    seen, cursor = [], None
    while True:
        kwargs = {"KeyConditionExpression": _Field("pk").eq("P")}
        if cursor:
            kwargs["ExclusiveStartKey"] = cursor
        page = table.query(**kwargs)
        seen += [item["sk"] for item in page["Items"]]
        cursor = page.get("LastEvaluatedKey")
        if cursor is None:
            break
    assert sorted(seen) == ["a", "b", "c", "d"] and len(seen) == 4


def test_a_page_exactly_page_size_long_has_no_cursor():
    # [A6] Boundary: when the rows fit the page exactly there is no further page to read.
    table = FakeTable()
    _rows(table)
    table.page_size = 4
    assert "LastEvaluatedKey" not in table.query(KeyConditionExpression=_Field("pk").eq("P"))


def test_a_limit_inside_a_cut_page_moves_the_cursor_to_the_last_returned_row():
    # [A7] Limit smaller than the filtered page → the cursor points at the last row RETURNED, not
    # the end of the page, so the next read doesn't skip the rows between.
    table = FakeTable()
    _rows(table)
    table.page_size = 3
    pending = {"KeyConditionExpression": _Field("pk").eq("P"),
               "FilterExpression": _Field("status").eq("PENDING"), "Limit": 1}
    first = table.query(**pending)
    second = table.query(**pending, ExclusiveStartKey=first["LastEvaluatedKey"])
    assert len(first["Items"]) == 1 and len(second["Items"]) == 1
    assert first["Items"][0]["sk"] != second["Items"][0]["sk"]
    assert first["LastEvaluatedKey"]["sk"] == first["Items"][0]["sk"]
