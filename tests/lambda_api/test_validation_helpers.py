"""Direct tests for the shared label/id validation helpers (WHIT-480).

`_validate_label` and `_validate_id` were extracted from set_milestones and
_validate_goal_checkpoints so the label + id contract can't drift between the two
save paths. These tests pin the shared contract itself, independent of either caller —
a fail-on-revert guard on the extraction.
"""

import json


def _error_body(response):
    return json.loads(response["body"])["error"]


# --- _validate_label ---------------------------------------------------------


def test_label_trims_and_accepts(handler):
    label, error = handler._validate_label("  Kickoff  ", 100, "milestone")
    assert error is None
    assert label == "Kickoff"


def test_label_at_max_len_accepted(handler):
    raw = "x" * 100
    label, error = handler._validate_label(raw, 100, "milestone")
    assert error is None
    assert label == raw


def test_label_over_max_len_rejected(handler):
    label, error = handler._validate_label("x" * 101, 100, "milestone")
    assert label is None
    assert error["statusCode"] == 400
    assert _error_body(error) == "milestone label too long"


def test_label_whitespace_only_rejected(handler):
    label, error = handler._validate_label("   ", 100, "checkpoint")
    assert label is None
    assert _error_body(error) == "each checkpoint needs a non-empty label"


def test_label_non_string_rejected(handler):
    label, error = handler._validate_label(42, 100, "milestone")
    assert label is None
    assert _error_body(error) == "each milestone needs a non-empty label"


def test_label_noun_flows_into_both_messages(handler):
    _, empty = handler._validate_label("", 100, "checkpoint")
    _, toolong = handler._validate_label("x" * 101, 100, "checkpoint")
    assert _error_body(empty) == "each checkpoint needs a non-empty label"
    assert _error_body(toolong) == "checkpoint label too long"


# --- _validate_id ------------------------------------------------------------


def test_id_mints_uuid_when_absent(handler):
    seen = set()
    new_id, error = handler._validate_id(None, seen, "milestone")
    assert error is None
    assert isinstance(new_id, str) and len(new_id) == 36
    assert new_id in seen


def test_id_trimmed_and_kept(handler):
    seen = set()
    new_id, error = handler._validate_id("  abc  ", seen, "checkpoint")
    assert error is None
    assert new_id == "abc"
    assert seen == {"abc"}


def test_id_blank_rejected(handler):
    new_id, error = handler._validate_id("   ", set(), "milestone")
    assert new_id is None
    assert _error_body(error) == "milestone id must be a non-empty string"


def test_id_non_string_rejected(handler):
    new_id, error = handler._validate_id(7, set(), "checkpoint")
    assert new_id is None
    assert _error_body(error) == "checkpoint id must be a non-empty string"


def test_id_duplicate_rejected(handler):
    seen = {"abc"}
    new_id, error = handler._validate_id("abc", seen, "milestone")
    assert new_id is None
    assert _error_body(error) == "milestone ids must be unique"


def test_id_whitespace_collides_with_trimmed(handler):
    """" a " trims to "a", which collides with an already-seen "a" (WHIT-383)."""
    seen = set()
    handler._validate_id("a", seen, "checkpoint")
    new_id, error = handler._validate_id(" a ", seen, "checkpoint")
    assert new_id is None
    assert _error_body(error) == "checkpoint ids must be unique"


def test_id_seen_set_mutated_only_on_success(handler):
    seen = set()
    handler._validate_id(None, seen, "milestone")
    assert len(seen) == 1
    handler._validate_id("   ", seen, "milestone")  # rejected — must not grow the set
    assert len(seen) == 1
