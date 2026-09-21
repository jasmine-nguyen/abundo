"""WHIT-465 Slice 5 — durable guards that the milestone-test consolidation STAYS consolidated.

WHIT-465 folded ~11 per-WHIT milestone test files into 4 topical survivors (lambda_api 8->3,
balance_poller 3->1), deduping one harness copy per survivor and renaming the colliding `_PLAN`
const. The implementer proved the fold was faithful ONCE (collect-only diff, AST no-dup scan).
These guards make two of those invariants DURABLE so a future fold into the same survivors can't
silently regress them — the same fail-on-revert idea WHIT-466 applies to the shared-fake modules,
but pointed at the WHIT-465 survivors (which carry their own local harness, so WHIT-466's registry
does not cover them):

  * [C1] no survivor has two top-level defs/consts with the SAME name. Folding N files into one can
         land two `test_...`/helper/const bindings with one name; Python keeps only the LAST and
         pytest silently drops the earlier test with no F811 here to flag it. This is the exact way
         a merged scenario disappears. (WHIT-466's [G3] guards this only for the shared milestone
         suites, not these survivors.)
  * [C2] the 8 files this slice deleted did NOT come back. Re-creating one re-splits the suite and
         re-duplicates a harness fake that can then drift from its twin — the drift WHIT-465 closed.
"""

import pathlib

import pytest

from _ast_bindings import _top_level_binding_list

_TESTS = pathlib.Path(__file__).resolve().parent.parent          # tests/

# The four topical survivors WHIT-465 folded everything into.
_SURVIVORS = [
    _TESTS / "lambda_api" / "test_milestones_api.py",
    _TESTS / "lambda_api" / "test_milestones_e2e.py",
    _TESTS / "lambda_api" / "test_milestones_whit447_mint_migration.py",
    _TESTS / "balance_poller" / "test_handler_milestone_gaps.py",
]

# The per-WHIT files this slice deleted — each was absorbed into a survivor above and must not
# reappear (path relative to tests/).
_DELETED = [
    "lambda_api/test_milestones_api_edges.py",
    "lambda_api/test_milestones_corrupt_row_e2e_gaps.py",
    "lambda_api/test_milestones_live_keys_e2e_gaps.py",
    "lambda_api/test_milestones_whit417_e2e_gaps.py",
    "lambda_api/test_milestones_whit424_e2e_gaps.py",
    "lambda_api/test_milestones_whit447_mint_migration_gaps.py",
    "balance_poller/test_handler_milestone_repo_wiring_gaps.py",
    "balance_poller/test_handler_milestone_scope_gaps.py",
]


# A survivor that got renamed/moved would make [C1] scan a missing file and error loudly rather
# than pass vacuously — assert the roster is real so the parametrization can't silently empty out.
assert _SURVIVORS, "no survivors registered for [C1]"
for _survivor in _SURVIVORS:
    assert _survivor.exists(), f"WHIT-465 survivor missing (renamed?): {_survivor}"
assert _DELETED, "no deleted files registered for [C2]"


@pytest.mark.parametrize("survivor", _SURVIVORS, ids=lambda p: p.name)
def test_survivor_has_no_duplicate_top_level_name(survivor):
    # [C1] fail-on-revert for fold-drift: two same-named top-level bindings mean a later fold
    # overwrote an earlier test/helper/const and Python kept only the last — a scenario silently
    # lost. A re-duplicated harness fake (e.g. a second `FakeNotifyRepo`) also trips here.
    names = _top_level_binding_list(survivor)
    dups = sorted({n for n in names if names.count(n) > 1})
    assert not dups, (
        f"{survivor.name} defines these top-level names more than once: {dups}. A fold/merge left "
        "two same-named defs or consts; Python keeps only the last and the earlier one is silently "
        "dropped. Rename the collision (per WHIT-465's _HIDDEN_ROW_PLAN / _RETARGET_PLAN pattern)."
    )


@pytest.mark.parametrize("deleted", _DELETED, ids=lambda p: pathlib.Path(p).name)
def test_deleted_milestone_file_did_not_return(deleted):
    # [C2] fail-on-revert for un-consolidation: the absorbed per-WHIT file must stay gone. Its
    # return re-splits the suite and re-introduces a harness-fake copy that can drift from the
    # survivor's — the twin-drift WHIT-465 removed.
    path = _TESTS / deleted
    assert not path.exists(), (
        f"{deleted} is back. WHIT-465 folded it into a survivor; a fresh copy re-splits the suite "
        "and re-duplicates its harness fakes. Add new milestone cases to the matching survivor "
        "instead of re-creating this file."
    )
