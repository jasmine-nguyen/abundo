"""WHIT-393 — meta-guard: does the WHIT-136 constants-sync test STILL go red on real drift?

test_constants_sync.py stopped carrying its own exec-into-a-fresh-namespace reader and now
delegates to tests/shared/_lambda_api_constants.constants_namespace. That guard is the one
whose failure mode is a DEPLOYED API that 500s on import (WHIT-54: 239 cryptic import
errors), and a guard's normal state is green — so a refactor that quietly made it pass
unconditionally would look exactly like a healthy run. Its sibling, the loan-facts ceiling
guard, has had this meta-cover since WHIT-393 ([D1]-[D7]); this is the same treatment for
the higher-blast-radius one.

Each test drives the REAL guard functions against a fabricated shared/ tree + lambda_api
constants file and asserts the outcome:

  [E1] green as shipped (the real files agree today);
  [E2] a name the shared layer imports is MISSING from lambda_api  -> AssertionError
       (the literal WHIT-54 failure);
  [E3] the name exists but the VALUE differs                       -> AssertionError;
  [E4] the two agree                                               -> both tests pass
       (so [E2]/[E3] are red for the drift, not for the fabrication);
  [E5] the shared layer imports NO constant                        -> AssertionError, not a
       vacuous green (the guard's own sanity assert);
  [E6] a shared module uses `import constants`                     -> AssertionError (the
       form the guard cannot enumerate — the WHIT-54 blind spot);
  [E7] a shared module uses `from constants import *`              -> AssertionError;
  [E8] the reader re-reads the FILE every call — a drift written to disk after a green run
       is seen without any reload (no sys.modules entry, no stale .pyc masking it).

The guard module is loaded by PATH into a throwaway module name so its own test functions
can be called directly here without pytest collecting them twice (same trick as
test_loanfacts_ceiling_sync_guard.py).
"""

import importlib.util
import pathlib

import pytest

_SYNC_PATH = pathlib.Path(__file__).resolve().parent / "test_constants_sync.py"


@pytest.fixture
def sync_guard():
    """The WHIT-136 guard module, loaded fresh (never registered in sys.modules)."""
    spec = importlib.util.spec_from_file_location("_whit393_constants_guard_under_test", _SYNC_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _fabricate(tmp_path, monkeypatch, sync_guard, *, shared_src, api_src,
               module_src="from constants import ALPHA, BETA\n"):
    """Point the guard at a throwaway shared/ tree and lambda_api constants file.

    Returns the api constants path so a test can rewrite it mid-run ([E8])."""
    shared_dir = tmp_path / "shared"
    shared_dir.mkdir()
    (shared_dir / "constants.py").write_text(shared_src)
    # A stand-in for repository_transaction.py: a shared module that pulls names from
    # `constants` at load, which is what makes them required in lambda_api's copy.
    (shared_dir / "repository_fake.py").write_text(module_src)
    api_path = tmp_path / "api_constants.py"
    api_path.write_text(api_src)

    monkeypatch.setattr(sync_guard, "_SHARED_DIR", shared_dir)
    monkeypatch.setattr(sync_guard, "_API_CONSTANTS", api_path)
    return api_path


def test_guard_is_green_as_shipped(sync_guard):
    """[E1] Baseline — both real assertions pass against the real files. If this ever fails,
    lambda_api/constants.py has genuinely drifted and the tests below prove nothing."""
    sync_guard.test_lambda_api_constants_cover_what_the_shared_layer_imports()
    sync_guard.test_lambda_api_constants_have_the_same_values_as_shared()


def test_guard_goes_red_when_lambda_api_is_missing_a_constant(sync_guard, tmp_path, monkeypatch):
    """[E2] The WHIT-54 failure exactly: a name the shared layer imports at load has no
    lambda_api counterpart, so the deployed API would 500 on import."""
    _fabricate(
        sync_guard=sync_guard, tmp_path=tmp_path, monkeypatch=monkeypatch,
        shared_src="ALPHA = 1\nBETA = 2\n",
        api_src="ALPHA = 1\n")
    with pytest.raises(AssertionError, match="missing constants"):
        sync_guard.test_lambda_api_constants_cover_what_the_shared_layer_imports()


def test_guard_goes_red_when_a_value_drifts(sync_guard, tmp_path, monkeypatch):
    """[E3] Both names exist but disagree — the API imports cleanly and then behaves
    differently from the webhook (the silent half of the landmine)."""
    _fabricate(
        sync_guard=sync_guard, tmp_path=tmp_path, monkeypatch=monkeypatch,
        shared_src="ALPHA = 1\nBETA = 2\n",
        api_src="ALPHA = 1\nBETA = 99\n")
    with pytest.raises(AssertionError, match="has drifted from"):
        sync_guard.test_lambda_api_constants_have_the_same_values_as_shared()


def test_guard_is_green_when_the_fabricated_pair_agrees(sync_guard, tmp_path, monkeypatch):
    """[E4] Control for [E2]/[E3]: the same fabrication, in sync, passes. Without this a
    typo'd fabrication could make those two red for the wrong reason."""
    _fabricate(
        sync_guard=sync_guard, tmp_path=tmp_path, monkeypatch=monkeypatch,
        shared_src="ALPHA = 1\nBETA = 2\nUNUSED = 3\n",
        api_src="ALPHA = 1\nBETA = 2\n")
    sync_guard.test_lambda_api_constants_cover_what_the_shared_layer_imports()
    sync_guard.test_lambda_api_constants_have_the_same_values_as_shared()


def test_guard_goes_red_when_the_scan_finds_no_imports(sync_guard, tmp_path, monkeypatch):
    """[E5] If the shared layout ever changed so the scan saw nothing, every comparison
    below it would pass over an empty set. The guard must call that out."""
    _fabricate(
        sync_guard=sync_guard, tmp_path=tmp_path, monkeypatch=monkeypatch,
        shared_src="ALPHA = 1\n",
        api_src="ALPHA = 1\n",
        module_src="# no constants imported here\n")
    with pytest.raises(AssertionError, match="at least one constant"):
        sync_guard.test_lambda_api_constants_cover_what_the_shared_layer_imports()


def test_guard_rejects_a_plain_import_constants(sync_guard, tmp_path, monkeypatch):
    """[E6] `import constants` + attribute access hides the names from the scan — the exact
    blind spot that let WHIT-54 through. The guard must refuse the form, not shrug."""
    _fabricate(
        sync_guard=sync_guard, tmp_path=tmp_path, monkeypatch=monkeypatch,
        shared_src="ALPHA = 1\n",
        api_src="ALPHA = 1\n",
        module_src="import constants\n\nVALUE = constants.ALPHA\n")
    with pytest.raises(AssertionError, match="enumerable"):
        sync_guard.test_lambda_api_constants_cover_what_the_shared_layer_imports()


def test_guard_rejects_a_star_import(sync_guard, tmp_path, monkeypatch):
    """[E7] `from constants import *` is the other un-enumerable form."""
    _fabricate(
        sync_guard=sync_guard, tmp_path=tmp_path, monkeypatch=monkeypatch,
        shared_src="ALPHA = 1\n",
        api_src="ALPHA = 1\n",
        module_src="from constants import *\n")
    with pytest.raises(AssertionError, match="star import"):
        sync_guard.test_lambda_api_constants_cover_what_the_shared_layer_imports()


def test_guard_re_reads_the_files_rather_than_caching(sync_guard, tmp_path, monkeypatch):
    """[E8] The delegated reader must follow the file on disk. A cache (or a stale
    __pycache__ entry, or a `constants` left in sys.modules by a sibling suite) would let a
    real drift keep reporting the value that was read first — a guard that is green about
    yesterday's file."""
    api_path = _fabricate(
        sync_guard=sync_guard, tmp_path=tmp_path, monkeypatch=monkeypatch,
        shared_src="ALPHA = 1\nBETA = 2\n",
        api_src="ALPHA = 1\nBETA = 2\n")
    sync_guard.test_lambda_api_constants_have_the_same_values_as_shared()

    api_path.write_text("ALPHA = 1\nBETA = 77\n")
    with pytest.raises(AssertionError, match="has drifted from"):
        sync_guard.test_lambda_api_constants_have_the_same_values_as_shared()
