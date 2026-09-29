"""WHIT-646 QA: the shared terraform readers fail loudly and read exactly one block.

The old up_webhook copies had no asserts, so a missing resource raised a bare AttributeError.
Every caller now relies on the shared readers naming what they couldn't find.
"""

import pytest

from _terraform import filter_pattern, tf_attr, tf_block

_TWO_RESOURCES = '''resource "aws_cloudwatch_metric_alarm" "first" {
  period = 3600
  dimensions = { FunctionName = "a" }
}

resource "aws_cloudwatch_metric_alarm" "second" {
  period = 86400
  threshold = 1
}
'''


# [A1] (P0) a missing resource / attribute / filter fails with a message naming it.
def test_missing_resource_attribute_and_filter_fail_with_a_named_message():
    with pytest.raises(AssertionError, match='resource "aws_cloudwatch_metric_alarm" "missing" not found'):
        tf_block(_TWO_RESOURCES, "aws_cloudwatch_metric_alarm", "missing")
    with pytest.raises(AssertionError, match="attribute threshold not found"):
        tf_attr(tf_block(_TWO_RESOURCES, "aws_cloudwatch_metric_alarm", "first"), "threshold")
    with pytest.raises(AssertionError, match="metric filter no_such_filter not found in monitoring.tf"):
        filter_pattern("no_such_filter")


# [A2] (P0) a block ends at its own closing brace: attributes of the next resource never leak in,
# and inline braces ({ FunctionName = ... }) don't cut the block short.
def test_block_stops_at_its_own_closing_brace():
    first = tf_block(_TWO_RESOURCES, "aws_cloudwatch_metric_alarm", "first")
    assert tf_attr(first, "period") == "3600"
    assert tf_attr(first, "dimensions") == '{ FunctionName = "a" }'
    assert "threshold" not in first

    second = tf_block(_TWO_RESOURCES, "aws_cloudwatch_metric_alarm", "second")
    assert tf_attr(second, "period") == "86400"


# [A3] (P1) tf_attr matches the whole key at line start, not a longer key that ends with it.
def test_attr_does_not_match_a_longer_key_ending_in_the_same_name():
    block = '  ok_actions = [b]\n  alarm_actions = [a]\n'
    assert tf_attr(block, "alarm_actions") == "[a]"
    with pytest.raises(AssertionError):
        tf_attr(block, "actions")
