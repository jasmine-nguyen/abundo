"""WHIT-469 Slice 3b — durable guards that the lambda_api directory sweep STAYS consolidated.

WHIT-469 folded 13 per-topic `_gaps`/`_edges` split files in tests/lambda_api/ back into their 9
neighbouring mains, dropping helper copies byte-identical to the main's and RENAMING the genuinely
drifted ones with a topic suffix (`_gaps`/`_edges`/`_nonfinite`) so nothing silently shadows. The
implementer proved the fold faithful ONCE (collect-only node-id diff identical modulo the registry
edit, suite green). These guards make two of those invariants DURABLE so a future fold into the same
mains can't silently regress them — the same fail-on-revert idea WHIT-465 [C1]/[C2] and WHIT-466
apply, pointed at THESE mains (which carry their own local harness helpers, so WHIT-466's registry
does not cover most of them; and its [G3] shadow-check covers only the milestone suites, not these):

  * [G4] no fold-target main has two top-level defs/consts with the SAME name. Folding N files into
         one can land two `test_...`/helper/const bindings under one name; Python keeps only the LAST
         and pytest silently drops the earlier one with no F811 here to flag it — the exact way a
         merged scenario or a drifted fake disappears. (WHIT-466 [G3] guards this only for the shared
         milestone suites; feed/handler sit in the registry with shadow_check=False, the other seven
         mains are not registered at all — so none of these nine are covered without this guard.)
  * [G5] the 13 files this slice deleted did NOT come back. Re-creating one re-splits the suite and
         re-duplicates a harness fake that can then drift from its twin — the drift WHIT-469 closed.
"""

import pathlib

import pytest

from _ast_bindings import _top_level_binding_list

_TESTS = pathlib.Path(__file__).resolve().parent.parent          # tests/
_API = _TESTS / "lambda_api"

# The nine mains WHIT-469 folded everything into.
_MAINS = [
    _API / "test_anthropic_client.py",
    _API / "test_breakdown.py",
    _API / "test_budget_transactions.py",
    _API / "test_devices.py",
    _API / "test_goals.py",
    _API / "test_handler.py",
    _API / "test_loanfacts.py",
    _API / "test_repayment.py",
    _API / "test_transactions_feed.py",
]

# The 13 split files this slice deleted — each was absorbed into a main above and must not reappear
# (path relative to tests/).
_DELETED = [
    "lambda_api/test_anthropic_client_gaps.py",
    "lambda_api/test_breakdown_income_gaps.py",
    "lambda_api/test_breakdown_refund_gaps.py",
    "lambda_api/test_budget_transactions_gaps.py",
    "lambda_api/test_budget_transactions_whit362_gaps.py",
    "lambda_api/test_devices_edge.py",
    "lambda_api/test_goals_gaps.py",
    "lambda_api/test_handler_whit275_gaps.py",
    "lambda_api/test_handler_whit296_gaps.py",
    "lambda_api/test_loanfacts_edges.py",
    "lambda_api/test_repayment_edges.py",
    "lambda_api/test_repayment_nonfinite_gaps.py",
    "lambda_api/test_transactions_feed_gaps.py",
]


# A main that got renamed/moved would make [G4] scan a missing file and error loudly rather than pass
# vacuously — assert the roster is real so the parametrization can't silently empty out.
assert _MAINS, "no fold-target mains registered for [G4]"
for _main in _MAINS:
    assert _main.exists(), f"WHIT-469 fold-target main missing (renamed?): {_main}"
assert _DELETED, "no deleted files registered for [G5]"


@pytest.mark.parametrize("main", _MAINS, ids=lambda p: p.name)
def test_fold_target_has_no_duplicate_top_level_name(main):
    # [G4] fail-on-revert for fold-drift: two same-named top-level bindings mean a later fold
    # overwrote an earlier test/helper/const and Python kept only the last — a scenario silently
    # lost, or a folded test silently rebound to the wrong same-named fake. A drifted fake that
    # should have been suffixed (e.g. a second FakeTransactionRepo instead of FakeTransactionRepo_edges)
    # also trips here.
    names = _top_level_binding_list(main)
    dups = sorted({n for n in names if names.count(n) > 1})
    assert not dups, (
        f"{main.name} defines these top-level names more than once: {dups}. A fold/merge left two "
        "same-named defs or consts; Python keeps only the last and the earlier one is silently "
        "dropped (or a folded test binds to the wrong fake). Rename the collision with a topic "
        "suffix (per WHIT-469's FakeTransactionRepo_edges / _nonfinite pattern)."
    )


@pytest.mark.parametrize("deleted", _DELETED, ids=lambda p: pathlib.Path(p).name)
def test_deleted_split_file_did_not_return(deleted):
    # [G5] fail-on-revert for un-consolidation: the absorbed split file must stay gone. Its return
    # re-splits the suite and re-introduces a harness-fake copy that can drift from the main's twin —
    # the twin-drift WHIT-469 removed.
    path = _TESTS / deleted
    assert not path.exists(), (
        f"{deleted} is back. WHIT-469 folded it into its neighbouring main; a fresh copy re-splits "
        "the suite and re-duplicates its harness fakes. Add new cases to the matching main instead "
        "of re-creating this file."
    )
