"""WHIT-466 gap coverage — the consolidated _boto_stubs helpers + the invariants AST helper.

The implementer's own checks prove the five guards ([G1]/[G1b]/[G2-static]/[G2-botocore]/[G3])
go red on violation, that the meta-guard reddens on an unregistered importer, and that the
installer is load-bearing. These cover the pieces the fold INTRODUCED that nothing else
exercises directly:

  * ``use_condition_fields()`` — its save/restore is the only thing stopping a leaked ``_Field``
    from poisoning a sibling suite that expects the import-only ``object`` sentinel; no other test
    asserts it restores (the repo suites pass whether or not it does, since they run inside it).
  * ``install_import_satisfiers()`` idempotency — "first suite wins, the rest no-op" is
    load-bearing (two suites collect in one process); nothing else pins that a 2nd call with a
    different ``ssm_default`` doesn't clobber an already-installed ssm.
  * ``_Field`` / ``_Predicate`` query semantics — the fake query engine the ``shared``/``lambda``
    repo suites lean on; its boundaries (``between`` inclusive, ``.get(name, "")`` default) are
    exactly the kind of thing a "tidy" could silently shift.
  * ``_top_level_binding_list``'s AnnAssign branch — the fold's [G1]/[G1b]/[G3] read names through
    it, and it claims to cover the annotated form, but every real fake uses a plain
    ``_UNSET = object()`` so that branch is otherwise unexercised.
"""

import importlib
import os
import sys
import types

from _boto_stubs import _Field, install_import_satisfiers, use_condition_fields


# --- use_condition_fields(): _Field inside, prior values restored after -----------------------

def test_use_condition_fields_swaps_in_field_and_restores_prior_value():
    # Inside the block Key/Attr are the recording _Field; after, they are the exact objects that
    # were there before (the import-satisfier `object` sentinel in normal runs).
    conditions = sys.modules["boto3.dynamodb.conditions"]
    before_key, before_attr = conditions.Key, conditions.Attr
    with use_condition_fields():
        assert conditions.Key is _Field
        assert conditions.Attr is _Field
    assert conditions.Key is before_key
    assert conditions.Attr is before_attr


def test_use_condition_fields_restores_even_when_body_raises():
    # The restore lives in a `finally`; an exception during a repo import must not leave `_Field`
    # bound where a sibling handler suite expects the plain sentinel.
    conditions = sys.modules["boto3.dynamodb.conditions"]
    before_key, before_attr = conditions.Key, conditions.Attr
    raised = False
    try:
        with use_condition_fields():
            assert conditions.Key is _Field  # proven swapped before the raise
            raise ValueError("boom during repo import")
    except ValueError:
        raised = True
    assert raised
    assert conditions.Key is before_key
    assert conditions.Attr is before_attr


def test_use_condition_fields_nests_without_losing_the_outer_restore():
    # save-current-then-restore (not save-once) means nesting collapses cleanly back to the
    # original, not to an inner `_Field`.
    conditions = sys.modules["boto3.dynamodb.conditions"]
    before_key = conditions.Key
    with use_condition_fields():
        with use_condition_fields():
            assert conditions.Key is _Field
        assert conditions.Key is _Field  # inner restored to what it saw: _Field
    assert conditions.Key is before_key


# --- install_import_satisfiers(): idempotent, first-writer-wins ---------------------------------

def test_install_import_satisfiers_does_not_clobber_an_installed_ssm():
    # The `if "ssm" not in sys.modules` guard is load-bearing: a 2nd suite's install with a different
    # default must leave the first suite's ssm (which tests may have monkeypatched) untouched.
    saved = sys.modules.get("ssm")
    sentinel = types.ModuleType("ssm")
    sentinel.get_param = lambda parameter_name: "SENTINEL-FIRST-WRITER"
    sys.modules["ssm"] = sentinel
    try:
        install_import_satisfiers(ssm_default="DIFFERENT-would-clobber")
        assert sys.modules["ssm"] is sentinel
        assert sys.modules["ssm"].get_param("/x") == "SENTINEL-FIRST-WRITER"
    finally:
        if saved is not None:
            sys.modules["ssm"] = saved
        else:
            sys.modules.pop("ssm", None)


def test_install_import_satisfiers_is_stable_for_boto3_and_env():
    # boto3 is installed once (identity stable across calls) and env uses setdefault (a pre-existing
    # AWS_REGION is not overwritten).
    boto3_before = sys.modules.get("boto3")
    saved_region = os.environ.get("AWS_REGION")
    os.environ["AWS_REGION"] = "sentinel-region"
    try:
        install_import_satisfiers()
        assert sys.modules.get("boto3") is boto3_before  # not re-created
        assert os.environ["AWS_REGION"] == "sentinel-region"  # setdefault, not overwrite
    finally:
        if saved_region is not None:
            os.environ["AWS_REGION"] = saved_region
        else:
            os.environ.pop("AWS_REGION", None)


# --- _Field / _Predicate: the fake query engine's boundaries -----------------------------------

def test_field_eq_gte_between_and_predicate_and_semantics():
    # Lock the fake query engine the repo suites evaluate against: eq, gte (>=), between (INCLUSIVE
    # both ends), and _Predicate.__and__ (logical AND over one item).
    assert _Field("pk").eq("A").evaluate({"pk": "A"}) is True
    assert _Field("pk").eq("A").evaluate({"pk": "B"}) is False
    assert _Field("date").gte("2024-01-01").evaluate({"date": "2024-01-01"}) is True   # >= is inclusive
    assert _Field("date").gte("2024-06-01").evaluate({"date": "2024-01-01"}) is False
    assert _Field("date").between("2024-01-01", "2024-12-31").evaluate({"date": "2024-01-01"}) is True
    assert _Field("date").between("2024-01-01", "2024-12-31").evaluate({"date": "2024-12-31"}) is True
    assert _Field("date").between("2024-01-01", "2024-12-31").evaluate({"date": "2025-01-01"}) is False
    combined = _Field("pk").eq("A") & _Field("date").gte("2024-01-01")
    assert combined.evaluate({"pk": "A", "date": "2024-05-01"}) is True
    assert combined.evaluate({"pk": "A", "date": "2023-05-01"}) is False


def test_field_missing_attribute_uses_empty_string_default():
    # gte/between read `item.get(name, "")`: an item missing the sorted key compares as "" (sorts
    # before any real date), so it must fall OUTSIDE a real date range, not crash.
    assert _Field("date").between("2024-01-01", "2024-12-31").evaluate({"pk": "A"}) is False
    assert _Field("date").gte("2024-01-01").evaluate({"pk": "A"}) is False


# --- _top_level_binding_list: the AnnAssign branch no real fake exercises -----------------------

def test_binding_list_captures_annotated_top_level_names(tmp_path):
    # The fold's [G1]/[G1b]/[G3] read names via _top_level_binding_list, whose docstring promises the
    # annotated form. Every real fake uses a plain `_UNSET = object()`, so this branch is otherwise
    # unexercised; a future annotated shared fake would slip past [G1] if it regressed. Assert an
    # `X: T = ...` top-level binding is captured (and duplicates are preserved for [G3]).
    invariants = importlib.import_module("test_fakes_invariants")
    source = (
        "import copy\n"
        "_SENTINEL: object = object()\n"       # AnnAssign with value
        "_ONLY_ANNOTATED: int\n"               # AnnAssign, no value (still a top-level name)
        "PLAIN = 1\n"
        "def dup(): pass\n"
        "dup = 2\n"                            # duplicate name across def + assign
    )
    sample = tmp_path / "sample_module.py"
    sample.write_text(source)
    names = invariants._top_level_binding_list(sample)
    assert "_SENTINEL" in names            # annotated-with-value captured
    assert "_ONLY_ANNOTATED" in names      # bare annotation captured
    assert names.count("dup") == 2         # list form preserves the duplicate [G3] relies on
    assert set(invariants._top_level_bindings(sample)) == set(names)  # set view is the deduped list
