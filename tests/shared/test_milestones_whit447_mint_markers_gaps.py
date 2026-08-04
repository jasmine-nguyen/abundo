"""WHIT-447 (gaps) — mint_migration_markers must key BYTE-IDENTICALLY to the poller.

The migrated "already celebrated" marker only keeps deduping if it matches exactly what the next
poll keys the saved row to. The poller keys a stored row through shared/milestones.py:_plan_marker
(cent-quantize, "id:<id>:bal:<amount>"); mint_migration_markers must produce the SAME strings for
the same stored Decimal — including the quantization edges the save endpoint allows through:
0, the 1_000_000_000 cap, and a sub-cent fraction (400000.005). If mint ever stopped routing
through _plan_marker (a hand-built f-string that skipped the quantize), the fractional case would
drift from the poller's key and the marker would be swept as dead — the exact re-arm bug.

No direct unit test for mint_migration_markers existed; these are it.
"""

from decimal import Decimal

import pytest


# stored Decimal(str(balance)) the save endpoint feeds mint, and the (legacy, idd) it must yield.
@pytest.mark.parametrize("stored, legacy, idd", [
    (Decimal(str(0)),               "bal:0.00",             "id:u1:bal:0.00"),
    (Decimal(str(1_000_000_000)),   "bal:1000000000.00",    "id:u1:bal:1000000000.00"),
    (Decimal(str(400000.005)),      "bal:400000.00",        "id:u1:bal:400000.00"),  # sub-cent → half-even
    (Decimal(str(55000.5)),         "bal:55000.50",         "id:u1:bal:55000.50"),
])
def test_mint_markers_match_the_literal_poller_key_at_quantization_edges(shared, stored, legacy, idd):
    got_legacy, got_idd = shared.milestones.mint_migration_markers(stored, "u1")
    assert (got_legacy, got_idd) == (legacy, idd)


@pytest.mark.parametrize("stored", [
    Decimal(str(0)), Decimal(str(1_000_000_000)), Decimal(str(400000.005)), Decimal(str(55000.5)),
])
def test_the_idd_marker_is_exactly_what_the_poller_would_key_the_stored_row_to(shared, stored):
    # The contract: the idd marker mint writes MUST equal the marker _plan_marker (the poller's
    # keying) builds for a row carrying that id + stored balance. Ties mint to the poller so a
    # future divergence (different quantize / prefix) fails here, not silently at the next poll.
    _, got_idd = shared.milestones.mint_migration_markers(stored, "u1")
    poller_key = shared.milestones._plan_marker({"id": "u1", "targetBalance": stored})
    assert got_idd == poller_key


@pytest.mark.parametrize("stored", [
    Decimal(str(0)), Decimal(str(400000.005)),
])
def test_the_legacy_marker_is_the_bare_id_less_form_the_poller_first_celebrated(shared, stored):
    # The legacy half must equal the id-LESS marker the poller keyed the row under before an id
    # existed — otherwise migrate would look for a bare marker that was never in the fired set and
    # silently no-op, leaving the celebration to re-arm.
    got_legacy, _ = shared.milestones.mint_migration_markers(stored, "u1")
    poller_bare = shared.milestones._plan_marker({"targetBalance": stored})
    assert got_legacy == poller_bare
    assert got_legacy.startswith("bal:") and "id:" not in got_legacy
