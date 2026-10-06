"""QA gaps for the folder-built _COLLIDING list (WHIT-625 slice 1).

The `handler`-style fixtures promise every module they import is fresh per test. The list is now
built from the folders, so pin that promise by behaviour, not by reading the list.
"""

import pathlib
import sys

import pytest

from _boto_stubs import FAKE_SSM_KEY

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]


def test_the_handler_fixture_sheds_every_lambda_api_module_and_the_shared_repository(request):
    # [A12] Plant a stale module under every lambda_api/ name plus `repository` (the shared name
    # the webhook folder also defines); the fixture must shed each one. FAIL-ON-REVERT: drop the
    # lambda_api glob or the shared∩other-lambdas term from conftest._COLLIDING.
    names = sorted({path.stem for path in (_REPO_ROOT / "lambda_api").glob("*.py")} | {"repository"})
    stale = {name: type(sys)(f"stale_{name}") for name in names}
    originals = {name: sys.modules.get(name) for name in names}

    def restore():
        for name in names:
            sys.modules.pop(name, None)
            if originals[name] is not None:
                sys.modules[name] = originals[name]

    request.addfinalizer(restore)  # registered first → runs after the fixture's own teardown
    sys.modules.update(stale)
    handler = request.getfixturevalue("handler")

    assert handler.__file__ == str(_REPO_ROOT / "lambda_api" / "handler.py")
    assert [name for name in names if sys.modules.get(name) is stale[name]] == []


# [A13] The two tests below run in file order. The anthropic_client fixture swaps
# api_key.get_param for a stub by plain assignment (tests/lambda_api/conftest.py). Before WHIT-625
# `api_key` was in _COLLIDING, so that stub died with the fixture; the folder-built list dropped it,
# so the stub now outlives the test and every later lambda_api test reads the Anthropic stub key as
# its BankSync key. The ssm value is pinned here so the test states the key it expects.
# FAIL-ON-REVERT of the fix: take api_key out of the shed set again.

@pytest.fixture
def pinned_ssm_key(monkeypatch):
    """Pin the BankSync key the handler should read, so a leftover stub can't pass for it."""
    monkeypatch.setattr(sys.modules["ssm"], "get_param", lambda path: FAKE_SSM_KEY)


def test_a_fixture_stubs_the_anthropic_key(anthropic_client):
    assert anthropic_client.get_api_key() == "test-anthropic-key"


@pytest.mark.usefixtures("pinned_ssm_key")
def test_a_later_handler_test_still_reads_the_ssm_key_not_the_leftover_stub(handler):
    import api_key

    api_key._cache.clear()
    assert handler.get_api_key() == FAKE_SSM_KEY
