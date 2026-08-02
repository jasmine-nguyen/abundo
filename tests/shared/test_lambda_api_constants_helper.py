"""WHIT-393 — the shared reader itself: tests/shared/_lambda_api_constants.py.

Both the WHIT-392 ceiling-sync guard and the loan-facts edges suite now get their server
number from `api_constant`, so a quietly-wrong reader would take BOTH of them down with it —
and a reader that returned a stale value would make the sync guard pass against a ceiling
nobody deploys. These pin the three properties the rest of the consolidation leans on:

  [B1] it returns a real, usable value for a name that exists;
  [B2] a name that does NOT exist fails loudly (never None, which would silently poison the
       parametrize tables in test_loanfacts_edges.py);
  [B3] it re-reads the file every call — no caching, no .pyc, no sys.modules;
  [B4] it does not register `constants` in sys.modules (the docstring's whole reason for
       exec'ing instead of importing — `constants` is in the _COLLIDING list of the
       lambda_api conftest, and importing it here would poison the sibling suites).
"""

import sys

import pytest

import _lambda_api_constants as helper
from _lambda_api_constants import api_constant


def test_returns_the_loanfacts_ceiling_as_a_positive_int():
    """[B1] The one constant the consolidation actually reads."""
    value = api_constant("LOANFACTS_FIELD_MAX")
    assert isinstance(value, int) and not isinstance(value, bool), (
        f"LOANFACTS_FIELD_MAX read back as {type(value).__name__} ({value!r}) — the "
        "parametrize tables in test_loanfacts_edges.py need a plain int"
    )
    assert value > 0


def test_unknown_constant_name_raises_key_error():
    """[B2] A typo'd/removed name must blow up here, not return None and let a
    `> None` comparison surface somewhere unrelated (or, worse, pass vacuously)."""
    with pytest.raises(KeyError):
        api_constant("NOT_A_REAL_CONSTANT_WHIT393")


def test_reads_the_file_on_every_call_rather_than_caching(tmp_path, monkeypatch):
    """[B3] The value must follow the file. If this ever regressed to a module-level
    cache, the sync guard would keep comparing against the ceiling that was on disk the
    first time the process touched it."""
    stub = tmp_path / "constants.py"
    stub.write_text("LOANFACTS_FIELD_MAX = 111\n")
    monkeypatch.setattr(helper, "_API_CONSTANTS", stub)

    assert api_constant("LOANFACTS_FIELD_MAX") == 111
    stub.write_text("LOANFACTS_FIELD_MAX = 222\n")
    assert api_constant("LOANFACTS_FIELD_MAX") == 222


def test_does_not_register_constants_in_sys_modules(monkeypatch):
    """[B4] Reading must not leave a `constants` module behind — that name collides with
    the lambda_api / sync_trigger / shared suites, and whichever one cached it first would
    win for the rest of the pytest process."""
    monkeypatch.delitem(sys.modules, "constants", raising=False)
    api_constant("LOANFACTS_FIELD_MAX")
    assert "constants" not in sys.modules, (
        "api_constant registered a `constants` module — it must exec the file into a "
        "fresh namespace, not import it (see the helper's docstring)"
    )


def test_the_namespace_is_not_shared_between_calls(tmp_path, monkeypatch):
    """A fresh namespace per call: a name defined by one read must not survive into the
    next, or a constant deleted from the file would keep resolving."""
    stub = tmp_path / "constants.py"
    stub.write_text("ONLY_HERE_FIRST = 1\n")
    monkeypatch.setattr(helper, "_API_CONSTANTS", stub)
    assert api_constant("ONLY_HERE_FIRST") == 1

    stub.write_text("SOMETHING_ELSE = 2\n")
    with pytest.raises(KeyError):
        api_constant("ONLY_HERE_FIRST")
