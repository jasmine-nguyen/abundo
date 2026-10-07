"""WHIT-775 — every suite gets the same fake ssm key, whichever test folder loads first.

The fake ``boto3`` (and its ssm client) is installed once per process (first install wins), so a
per-suite default made the key depend on run order. One shared ``FAKE_SSM_KEY`` removes that.
"""

import sys

import pytest

import _boto_stubs
from _conftest_probe import run_conftest_in_fresh_process

_SUITES_WITH_FAKE_SSM = (
    "shared", "goal_nudge", "push_receipts", "balance_poller", "lambda_api", "sync_trigger",
)
_READ_KEY = 'sys.modules["boto3"].client("ssm").get_parameter(Name="/any/path")["Parameter"]["Value"]'


def test_fresh_install_returns_the_shared_key_and_is_idempotent(monkeypatch):
    monkeypatch.delitem(sys.modules, "boto3", raising=False)
    _boto_stubs.install_import_satisfiers()
    installed = sys.modules["boto3"]
    assert installed.client("ssm").get_parameter(Name="/any/path")["Parameter"]["Value"] == _boto_stubs.FAKE_SSM_KEY

    _boto_stubs.install_import_satisfiers()
    assert sys.modules["boto3"] is installed


@pytest.mark.parametrize("suite", _SUITES_WITH_FAKE_SSM)
def test_suite_loaded_first_sets_the_same_fake_key(suite):
    # A fresh process where this suite's conftest is the first thing to load: the key it leaves
    # behind is what every later suite in the run would see.
    key = run_conftest_in_fresh_process(suite, report=_READ_KEY)
    assert key == _boto_stubs.FAKE_SSM_KEY
