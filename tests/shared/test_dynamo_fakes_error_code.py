"""WHIT-675: the FakeTable suites read a ClientError's code through one shared helper."""

import ast
from pathlib import Path

import pytest
from botocore.exceptions import ClientError

from _dynamo_fakes import FakeTable, error_code

_TESTS_ROOT = Path(__file__).resolve().parents[1]
_HELPER_NAMES = {"_code", "error_code"}


def test_error_code_reads_the_dynamodb_code_off_a_rejected_fake_table_write():
    table = FakeTable()

    with pytest.raises(ClientError) as empty_add:
        table.update_item(Key={"pk": "N", "sk": "FIRED"}, UpdateExpression="ADD #f :m",
                          ExpressionAttributeNames={"#f": "fired"}, ExpressionAttributeValues={":m": set()})

    assert error_code(empty_add) == "ValidationException"


def test_the_error_code_helper_is_defined_exactly_once_in_the_test_tree():
    definitions = []
    for path in sorted(_TESTS_ROOT.rglob("*.py")):
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name in _HELPER_NAMES:
                definitions.append(f"{path.relative_to(_TESTS_ROOT)}:{node.name}")

    assert definitions == ["shared/_dynamo_fakes.py:error_code"]
