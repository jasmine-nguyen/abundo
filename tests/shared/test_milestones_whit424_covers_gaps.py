"""WHIT-424 — GAP tests for LiveMarkers.covers() and the "id:<row id>:" prefix boundary.

Already locked in test_milestones_live_keys_gaps.py, NOT repeated here: an unreadable-target row
with a readable id keeps its markers ([L1]); the same row with no readable id loses them; a
re-targeted / re-identified unreadable row still loses its old marker ([L2]); the legacy id-less
"bal:<amount>" vs id'd collision ([L3]); the non-list plan ([L4]); the ordering guard ([L5]).

What none of them cover — the SUBSTRING-id boundary the trailing colon in `_row_id_prefix`
exists to defend (candidate angle #1). Client-supplied ids are preserved verbatim after a trim
(lambda_api/handler.py:2143-2154), so a plan can hold ids "a" AND "ab" at once. The marker
prefix is "id:<id>:" WITH a trailing colon precisely so "id:a:" does not swallow "id:ab:bal:...":

  * covers() itself: "id:a:" must cover its own row's markers but NOT a longer id's, NOT a legacy
    "bal:" marker, NOT a built-in sprint marker.
  * end to end through the sweep: an unreadable-target row id "a" keeps its own "id:a:..." markers
    while a since-deleted longer-id row's "id:ab:..." marker is still swept. Fail-on-revert: drop
    the trailing colon from _row_id_prefix -> "id:a" leaks over "id:ab:..." and the sweep stops.
  * two unreadable rows with distinct ids: id_prefixes is a SET, each prefix covers only its own.
"""

from decimal import Decimal

# Shared milestone fakes + row fixtures (WHIT-445).
from _milestone_fakes import (
    FakeDeviceRepo, FakeLoanFactsRepo, FakeMilestoneRepo, FakeNotifyRepo, recorder,
)
from _milestone_row_fakes import _GOOD, _KEEP_MARKER, _row


def _sweep(shared, stored, fired):
    """A no-crossing poll (balance far above every target): the WHIT-385 sweep runs alone."""
    notify = FakeNotifyRepo(fired=fired)
    shared.milestones.notify_milestone_crossing(
        Decimal("900000"), Decimal("850000"),
        loanfacts_repo=FakeLoanFactsRepo(), device_repo=FakeDeviceRepo(),
        notify_repo=notify, milestone_repo=FakeMilestoneRepo(stored))
    return notify


# --- covers() the primitive: startswith with the trailing colon, not `in`, not a bare prefix --

def test_covers_matches_exact_membership_and_an_id_prefix(shared):
    lm = shared.milestones.LiveMarkers(
        frozenset({"id:keep:bal:300000.00", "0"}), frozenset({"id:a:"}))
    assert lm.covers("id:keep:bal:300000.00") is True          # exact
    assert lm.covers("0") is True                              # exact (a built-in sprint marker)
    assert lm.covers("id:a:bal:250000.00") is True             # under the live id prefix
    assert lm.covers("id:a:bal:999999.00") is True             # any amount under that id


def test_covers_id_prefix_does_not_leak_across_a_substring_id(shared):
    # The trailing colon is load-bearing: "id:a:" must not cover a longer id's marker. If covers()
    # ever used `in` or a colon-less prefix, "id:ab:..." / "id:a2:..." would be wrongly kept.
    lm = shared.milestones.LiveMarkers(frozenset(), frozenset({"id:a:"}))
    assert lm.covers("id:ab:bal:300000.00") is False
    assert lm.covers("id:a2:bal:300000.00") is False
    assert lm.covers("id:abc:bal:0.00") is False
    assert lm.covers("bal:300000.00") is False                 # a legacy id-less marker
    assert lm.covers("0") is False                             # a built-in sprint marker


def test_covers_with_no_prefixes_is_exact_only(shared):
    lm = shared.milestones.LiveMarkers(frozenset({"id:x:bal:1.00"}), frozenset())
    assert lm.covers("id:x:bal:1.00") is True
    assert lm.covers("id:x:bal:2.00") is False                 # no prefix -> no amount wildcard


# --- end to end through _resolve_plan + the sweep: the trailing colon actually defends ---------

def test_a_short_id_unreadable_row_does_not_keep_a_longer_ids_deleted_marker(shared, recorder):
    # Row "a" has an unreadable target (id readable) -> _resolve_plan registers the prefix "id:a:".
    # A since-DELETED row once had id "ab" and fired "id:ab:bal:770000.00" — that id is gone from
    # the plan, so its marker must still be swept. Only the trailing colon in _row_id_prefix keeps
    # "id:a:" from covering it. Fail-on-revert: return "id:a" (no colon) -> stale is NOT removed.
    bad = _row(id="a", targetBalance="oops")          # unreadable target, readable id
    own = "id:a:bal:250000.00"                         # row a's own once-ever marker
    stale = "id:ab:bal:770000.00"                      # the deleted longer-id row's marker

    notify = _sweep(shared, [_GOOD, bad], fired={_KEEP_MARKER, own, stale})

    assert notify.removed == {stale}                   # id:a: must NOT cover id:ab:...
    assert own in notify.fired                         # row a keeps its own marker via the prefix
    assert _KEEP_MARKER in notify.fired                # the readable row keeps its exact marker


def test_two_unreadable_rows_with_distinct_ids_each_keep_only_their_own(shared, recorder):
    # id_prefixes is a SET: two unreadable-target rows register two prefixes, and each covers ONLY
    # its own markers while an unrelated deleted row's marker is still reaped in the same poll.
    bad_p = _row(id="p", targetBalance="oops")
    bad_q = _row(id="q", targetBalance="oops")
    m_p = "id:p:bal:250000.00"
    m_q = "id:q:bal:120000.00"
    gone = "id:gone:bal:999999.00"

    notify = _sweep(shared, [_GOOD, bad_p, bad_q], fired={_KEEP_MARKER, m_p, m_q, gone})

    assert notify.removed == {gone}
    assert {m_p, m_q, _KEEP_MARKER} <= notify.fired
