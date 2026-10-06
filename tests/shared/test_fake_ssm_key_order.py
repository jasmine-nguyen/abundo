"""WHIT-775 — every suite gets the same fake ssm key, whichever test folder loads first.

The fake ``ssm`` is installed once per process (first install wins), so a per-suite default
made the key depend on run order. One shared ``FAKE_SSM_KEY`` removes that.
"""

import sys
import types

import pytest

import _boto_stubs
from _conftest_probe import run_conftest_in_fresh_process

_SUITES_WITH_FAKE_SSM = (
    "shared", "goal_nudge", "push_receipts", "balance_poller", "lambda_api", "sync_trigger",
)


def test_fresh_install_returns_the_shared_key_and_never_replaces_an_existing_ssm(monkeypatch):
    monkeypatch.delitem(sys.modules, "ssm", raising=False)
    _boto_stubs.install_import_satisfiers()
    installed = sys.modules["ssm"]
    assert _boto_stubs.FAKE_SSM_KEY == "test-api-key"
    assert installed.get_param("/any/path") == "test-api-key"

    _boto_stubs.install_import_satisfiers()
    assert sys.modules["ssm"] is installed

    existing = types.ModuleType("ssm")
    existing.get_param = lambda parameter_name: "already-installed"
    monkeypatch.setitem(sys.modules, "ssm", existing)
    _boto_stubs.install_import_satisfiers()
    assert sys.modules["ssm"] is existing


@pytest.mark.parametrize("suite", _SUITES_WITH_FAKE_SSM)
def test_suite_loaded_first_sets_the_same_fake_key(suite):
    # A fresh process where this suite's conftest is the first thing to load: the key it leaves
    # behind is what every later suite in the run would see.
    key = run_conftest_in_fresh_process(suite, report='sys.modules["ssm"].get_param("/any/path")')
    assert key == "test-api-key"
