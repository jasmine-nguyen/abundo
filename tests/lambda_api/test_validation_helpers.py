"""Direct tests for the shared label/id validation helpers (WHIT-480).

`_validate_label` and `_validate_id` were extracted from set_milestones and
_validate_goal_checkpoints so the label + id contract can't drift between the two
save paths. These tests pin the shared contract itself, independent of either caller.
"""

import pytest


@pytest.mark.parametrize(("raw", "expected"), [
    ("  Kickoff  ", "Kickoff"),     # trimmed
    ("x" * 100, "x" * 100),         # exactly the max length
    ("x" * 101, None),              # one over
    ("   ", None),                  # whitespace only
])
def test_validate_label(handler, raw, expected):
    label, error = handler._validate_label(raw, 100, "milestone")
    assert label == expected
    if expected is None:
        assert error["statusCode"] == 400
        return
    assert error is None


def test_id_mints_uuid_when_absent(handler):
    seen = set()
    new_id, error = handler._validate_id(None, seen, "milestone")
    assert error is None
    assert isinstance(new_id, str) and len(new_id) == 36
    assert new_id in seen


@pytest.mark.parametrize(("seen", "raw", "expected"), [
    (set(), "  abc  ", "abc"),      # trimmed and kept
    (set(), "   ", None),           # blank
    ({"abc"}, "abc", None),         # duplicate
    ({"a"}, " a ", None),           # trims to an id already seen (WHIT-383)
])
def test_validate_id(handler, seen, raw, expected):
    seen = set(seen)
    new_id, error = handler._validate_id(raw, seen, "checkpoint")
    assert new_id == expected
    if expected is None:
        assert error["statusCode"] == 400
        return
    assert error is None
    assert expected in seen
