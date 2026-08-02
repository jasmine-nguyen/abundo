"""WHIT-393 — meta-guard: does the WHIT-392 ceiling-sync test STILL go red on real drift?

test_loanfacts_ceiling_sync.py stopped reading lambda_api/constants.py itself and now
delegates to tests/shared/_lambda_api_constants.py. A refactor of a guard is exactly the
change that can leave the guard passing unconditionally — and nothing would notice, because
a guard's normal state IS green. These drive the guard against a fabricated client file /
server value and assert it FAILS:

  [D1] the guard passes as shipped (client and server agree today);
  [D2] server ceiling moves, client doesn't      -> AssertionError;
  [D3] client ceiling moves, server doesn't      -> AssertionError;
  [D4] the client declaration disappears/renamed -> AssertionError (no vacuous pass);
  [D5] a second, shadowing client declaration    -> AssertionError;
  [D6] the regex still matches the WHIT-393 `export const` form (it used to be a bare
       `const`; a regex that missed `export` would fail [D4]-style, but this pins the
       intent rather than leaving it to luck);
  [D7] the number the helper reads is the number the deployed handler actually enforces —
       i.e. the guard is guarding the right file.

The guard module is loaded by PATH into a throwaway module name so its own test functions
can be called directly here without pytest collecting them twice.
"""

import importlib.util
import pathlib

import pytest

from _lambda_api_constants import api_constant

_SYNC_PATH = pathlib.Path(__file__).resolve().parent / "test_loanfacts_ceiling_sync.py"


@pytest.fixture
def sync_guard():
    """The WHIT-392 guard module, loaded fresh (never registered in sys.modules)."""
    spec = importlib.util.spec_from_file_location("_whit393_sync_guard_under_test", _SYNC_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _client_file(tmp_path, body: str) -> pathlib.Path:
    path = tmp_path / "loanLimits.ts"
    path.write_text(body)
    return path


def test_guard_is_green_as_shipped(sync_guard):
    """[D1] Baseline — the three real assertions pass against the real files. If this ever
    fails, the ceilings have genuinely drifted and the tests below prove nothing."""
    sync_guard.test_client_ceiling_parses_to_a_positive_int()
    sync_guard.test_exactly_one_client_ceiling_declaration()
    sync_guard.test_client_and_server_loanfacts_ceilings_agree()


def test_guard_goes_red_when_the_server_ceiling_drifts(sync_guard, monkeypatch):
    """[D2] Someone edits lambda_api/constants.py and forgets src/loanLimits.ts."""
    client = sync_guard._client_ceiling()
    monkeypatch.setattr(sync_guard, "api_constant", lambda name: client + 1)
    with pytest.raises(AssertionError, match="ceiling drift"):
        sync_guard.test_client_and_server_loanfacts_ceilings_agree()


def test_guard_goes_red_when_the_client_ceiling_drifts(sync_guard, tmp_path, monkeypatch):
    """[D3] Someone edits src/loanLimits.ts and forgets the server."""
    monkeypatch.setattr(
        sync_guard, "_CLIENT_LIMITS",
        _client_file(tmp_path, "export const LOANFACTS_FIELD_MAX = 12_345;\n"))
    with pytest.raises(AssertionError, match="ceiling drift"):
        sync_guard.test_client_and_server_loanfacts_ceilings_agree()


def test_guard_goes_red_when_the_client_declaration_disappears(sync_guard, tmp_path, monkeypatch):
    """[D4] The const is renamed/inlined: the parser must say so rather than let the
    equality assertion pass on nothing."""
    monkeypatch.setattr(
        sync_guard, "_CLIENT_LIMITS",
        _client_file(tmp_path, "// LOANFACTS_FIELD_MAX lives somewhere else now\n"))
    with pytest.raises(AssertionError, match="could not locate"):
        sync_guard.test_client_ceiling_parses_to_a_positive_int()


def test_guard_goes_red_on_a_shadowing_second_declaration(sync_guard, tmp_path, monkeypatch):
    """[D5] A leftover/commented-out old value above the live one would be the value
    compared (the parser takes the FIRST match)."""
    monkeypatch.setattr(
        sync_guard, "_CLIENT_LIMITS",
        _client_file(tmp_path, (
            "const LOANFACTS_FIELD_MAX = 500_000_000;\n"
            "export const LOANFACTS_FIELD_MAX = 1_000_000_000;\n")))
    with pytest.raises(AssertionError, match="exactly one"):
        sync_guard.test_exactly_one_client_ceiling_declaration()


def test_guard_reads_an_exported_declaration(sync_guard, tmp_path, monkeypatch):
    """[D6] WHIT-393 changed the client line from `const` to `export const` so the loan
    suites can import it. The parser must keep seeing it — and see exactly one."""
    monkeypatch.setattr(
        sync_guard, "_CLIENT_LIMITS",
        _client_file(tmp_path, "export const LOANFACTS_FIELD_MAX = 7;\n"))
    assert sync_guard._client_ceiling() == 7
    sync_guard.test_exactly_one_client_ceiling_declaration()


def test_helper_reads_the_ceiling_the_handler_enforces(handler):
    """[D7] The guard compares the client against whatever `api_constant` reads. If that
    ever pointed at the wrong constants.py (shared/ has no LOANFACTS_FIELD_MAX; a stale path
    would read an old copy), the guard would be policing a number the API doesn't use."""
    assert api_constant("LOANFACTS_FIELD_MAX") == handler.LOANFACTS_FIELD_MAX
