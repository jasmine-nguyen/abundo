"""Shared stored-row fixtures for the milestone-row validity suites (WHIT-445).

The row-shape suites (test_milestone_rows*, test_milestones_whit417/424_gaps,
test_milestones_live_keys_gaps) each carried their own copy of the same "one good stored
row" builder and the raw-row store injector. They live here now, in ONE definition, so the
row shape can't drift between the suites that assert parity across the two read paths.

The repo/notify class fakes those suites use come from the sibling _milestone_fakes.py.
Resolved by pytest.ini's `pythonpath = tests/shared`; pure stdlib, no shared/-layer import.
"""

from decimal import Decimal


# One valid stored milestone row (targetBalance as a Decimal, as get_milestones_raw returns
# it). Tests override individual fields via _row(**overrides); every id-sensitive test passes
# its own id, so the default id="keep" is a label, not an assertion.
_GOOD = {"id": "keep", "label": "Halfway", "targetBalance": Decimal("300000"),
         "targetDate": "2030-01-01"}

# The dedup marker _GOOD resolves to — the live-marker the sweep suites must NOT remove.
_KEEP_MARKER = "id:keep:bal:300000.00"


def _row(**overrides):
    return {**_GOOD, **overrides}


def _store_raw_row(milestone_repo, milestones, scope="SHARED"):
    """Inject a stored row directly, bypassing set_milestones' validation, to mimic a legacy
    or partially-written row (mirrors tests/shared/test_repository_milestone.py)."""
    milestone_repo._table.store[("MILESTONES", scope)] = {
        "pk": "MILESTONES", "sk": scope, "milestones": milestones,
    }
