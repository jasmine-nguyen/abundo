"""WHIT-680 QA: edge cases of the shared IAM policy readers in tests/shared/_terraform.py."""

from _terraform import allows, leading_keys, policy_statements

SCOPED_DELETE = """{
        Effect = "Allow"
        Action = ["dynamodb:DeleteItem"]
        Condition = {
          "ForAllValues:StringLike" = {
            "dynamodb:LeadingKeys" = ["RULE", "ACCOUNT#*"]
          }
        }
      }"""

UNSCOPED_DELETE = """{
        Effect = "Allow"
        Action = ["dynamodb:DeleteItem"]
      }"""


# [A1] P0 — a scoped statement that doesn't match must not end the search: a later unscoped grant still allows.
def test_a_non_matching_scoped_statement_does_not_hide_a_later_unscoped_grant():
    assert allows([SCOPED_DELETE, UNSCOPED_DELETE], "DeleteItem", "CATEGORIES") is True
    assert allows([SCOPED_DELETE], "DeleteItem", "CATEGORIES") is False


# [A2] P0 — every pattern in a multi-key scope counts, exact keys stay exact, and matching is case-sensitive.
def test_multi_pattern_scope_matches_each_pattern_exactly_and_case_sensitively():
    assert leading_keys(SCOPED_DELETE) == ["RULE", "ACCOUNT#*"]
    assert allows([SCOPED_DELETE], "DeleteItem", "RULE") is True
    assert allows([SCOPED_DELETE], "DeleteItem", "ACCOUNT#abc") is True
    assert allows([SCOPED_DELETE], "DeleteItem", "RULES") is False
    assert allows([SCOPED_DELETE], "DeleteItem", "account#abc") is False


# [A3] P1 — the reader works for the app server's policy too (the fourth consumer), not just the trigger's.
def test_policy_statements_reads_the_app_api_policy_and_its_delete_scope():
    statements = policy_statements("app_api_dynamodb")
    assert len(statements) > 1
    assert all(statement.startswith("{") and statement.endswith("}") for statement in statements)
    scopes = [leading_keys(statement) for statement in statements if leading_keys(statement) is not None]
    assert scopes == [["RULE", "ACCOUNT#*"]]
    assert allows(statements, "DeleteItem", "RULE") is True
    assert allows(statements, "DeleteItem", "CATEGORIES") is False
