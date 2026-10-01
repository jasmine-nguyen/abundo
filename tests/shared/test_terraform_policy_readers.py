"""WHIT-680: the IAM policy readers live once, in tests/shared/_terraform.py.

The trigger role's permission tests each kept their own copy of "split the policy into
statements / read a statement's LeadingKeys / does the policy allow this call on this row".
These pin the shared copy's behaviour (including the None partition key a query passes)
and that no sync_trigger test file grows its own copy again.
"""

import pathlib
import re

from _terraform import allows, leading_keys, policy_statements

_SYNC_TRIGGER_TESTS = pathlib.Path(__file__).resolve().parents[1] / "sync_trigger"

UNSCOPED = """{
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:Query"
        ]
      }"""

SCOPED = """{
        Effect = "Allow"
        Action = ["dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem"]
        Condition = {
          "ForAllValues:StringLike" = {
            "dynamodb:LeadingKeys" = ["ACCOUNT#*"]
          }
        }
      }"""


def test_shared_policy_readers_match_rows_against_the_leading_keys_scope():
    assert leading_keys(UNSCOPED) is None
    assert leading_keys(SCOPED) == ["ACCOUNT#*"]

    statements = [UNSCOPED, SCOPED]
    assert allows(statements, "GetItem", "CATEGORIES") is True
    assert allows(statements, "Query", None) is True
    assert allows(statements, "DeleteItem", "ACCOUNT#abc") is True
    assert allows(statements, "DeleteItem", "CATEGORIES") is False
    # A scoped grant can't be proven for a call with no partition key.
    assert allows(statements, "UpdateItem", None) is False
    assert allows(statements, "PutItem", "ACCOUNT#abc") is False

    real = policy_statements("transaction_trigger_dynamodb")
    assert len(real) == 2
    assert all(statement.startswith("{") and statement.endswith("}") for statement in real)
    assert allows(real, "Query", None) is True
    assert allows(real, "BatchWriteItem", "ACCOUNT#abc") is True
    assert allows(real, "BatchWriteItem", "RULE") is False
    assert allows(real, "PutItem", "ACCOUNT#abc") is False


def test_no_sync_trigger_test_keeps_its_own_policy_reader():
    local_copy = re.compile(
        r"^\s*def _(statements|leading_keys|allows|policy_statements)\(|"
        r"\bpolicy_qa\._(statements|allows|leading_keys)\b",
        re.M)
    offenders = sorted(
        path.name
        for path in _SYNC_TRIGGER_TESTS.rglob("*.py")
        if local_copy.search(path.read_text())
    )
    assert offenders == [], f"import policy_statements / leading_keys / allows from _terraform instead: {offenders}"
