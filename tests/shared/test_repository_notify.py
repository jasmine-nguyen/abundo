"""Tests for NotifyRepository (shared/repository_notify.py).

The real repository runs over the shared FakeTable (WHIT-625), so the String-Set ADD/DELETE, the
TTL SET and the WHIT-577 conditional claim are DynamoDB's semantics, not a copy of the rule.
Different cycle keys map to different items, so a new cycle re-arms.
"""

import pytest
from decimal import Decimal

from _dynamo_fakes import FakeTable


def _repo(shared, *_):
    r = shared.notify.NotifyRepository()
    r._table = FakeTable()
    return r


def _assert_no_ttl_written(table):
    for expression, names, values in table.update_calls:
        assert "#e" not in names and ":exp" not in values, expression


def test_no_markers_before_any_fire(shared):
    assert _repo(shared).fired_markers("2026-07-01", 14) == set()


def test_mark_then_read_round_trips(shared):
    r = _repo(shared)
    r.mark_fired("2026-07-01", 14, "groceries#80")
    assert r.fired_markers("2026-07-01", 14) == {"groceries#80"}


def test_mark_is_idempotent(shared):
    r = _repo(shared)
    r.mark_fired("2026-07-01", 14, "groceries#80")
    r.mark_fired("2026-07-01", 14, "groceries#80")
    assert r.fired_markers("2026-07-01", 14) == {"groceries#80"}


def test_two_markers_coexist_in_the_cycle(shared):
    r = _repo(shared)
    r.mark_fired("2026-07-01", 14, "groceries#80")
    r.mark_fired("2026-07-01", 14, "groceries#100")
    assert r.fired_markers("2026-07-01", 14) == {"groceries#80", "groceries#100"}


def test_different_cycle_is_a_separate_marker_set(shared):
    r = _repo(shared)
    r.mark_fired("2026-07-01", 14, "groceries#80")
    # A new pay cycle (different last_pay_date) → different pk → re-armed.
    assert r.fired_markers("2026-07-15", 14) == set()


def test_mark_writes_a_ttl(shared):
    r = _repo(shared)
    r.mark_fired("2026-07-01", 14, "groceries#80")
    item = r._table.store[("NOTIFY#2026-07-01#14", "FIRED")]
    assert isinstance(item["expires_at"], int) and item["expires_at"] > 0


def test_client_error_surfaces_as_database_error(shared, client_error, database_error):
    r = _repo(shared)

    def boom(**kwargs):
        raise client_error("InternalServerError")

    r._table.update_item = boom
    with pytest.raises(database_error):
        r.mark_fired("2026-07-01", 14, "groceries#80")


# --- WHIT-577: claim before send, release when the push didn't land -----------


def test_claim_on_a_new_cycle_creates_the_marker_and_ttl(shared, client_error):
    r = _repo(shared, client_error)
    assert r.claim_fired("2026-07-01", 14, "groceries#80") is True
    item = r._table.store[("NOTIFY#2026-07-01#14", "FIRED")]
    assert item["fired"] == {"groceries#80"}
    assert isinstance(item["expires_at"], int) and item["expires_at"] > 0


def test_claim_beside_other_markers_adds_this_one(shared, client_error):
    r = _repo(shared, client_error)
    r.mark_fired("2026-07-01", 14, "coffee#80")
    assert r.claim_fired("2026-07-01", 14, "groceries#80") is True
    assert r.fired_markers("2026-07-01", 14) == {"coffee#80", "groceries#80"}


def test_second_claim_of_the_same_marker_loses_without_raising(shared, client_error):
    # Another delivery already claimed it. Fail-on-revert: route ConditionalCheckFailed
    # through handle_database_error → DatabaseError instead of False.
    r = _repo(shared, client_error)
    assert r.claim_fired("2026-07-01", 14, "groceries#80") is True
    assert r.claim_fired("2026-07-01", 14, "groceries#80") is False


def test_claim_other_errors_surface_as_database_error(shared, client_error, database_error):
    r = _repo(shared, client_error)

    def boom(**kwargs):
        raise client_error("InternalServerError")

    r._table.update_item = boom
    with pytest.raises(database_error):
        r.claim_fired("2026-07-01", 14, "groceries#80")


def test_release_lets_the_marker_be_claimed_again(shared, client_error):
    r = _repo(shared, client_error)
    r.claim_fired("2026-07-01", 14, "groceries#80")
    r.release_fired("2026-07-01", 14, "groceries#80")
    assert r.fired_markers("2026-07-01", 14) == set()
    assert r.claim_fired("2026-07-01", 14, "groceries#80") is True


def test_release_keeps_the_other_markers(shared, client_error):
    r = _repo(shared, client_error)
    r.mark_fired("2026-07-01", 14, "coffee#80")
    r.claim_fired("2026-07-01", 14, "groceries#80")
    r.release_fired("2026-07-01", 14, "groceries#80")
    assert r.fired_markers("2026-07-01", 14) == {"coffee#80"}


def test_release_error_surfaces_as_database_error(shared, client_error, database_error):
    r = _repo(shared, client_error)

    def boom(**kwargs):
        raise client_error("InternalServerError")

    r._table.update_item = boom
    with pytest.raises(database_error):
        r.release_fired("2026-07-01", 14, "groceries#80")


# --- repayment-notify markers (WHIT-15), keyed on transaction id --------------


def test_no_repayment_markers_before_any_fire(shared):
    assert _repo(shared).fired_repayments() == set()


def test_mark_repayment_then_read_round_trips(shared):
    r = _repo(shared)
    r.mark_repayment_fired("txn-1")
    assert r.fired_repayments() == {"txn-1"}


def test_mark_repayment_is_idempotent(shared):
    r = _repo(shared)
    r.mark_repayment_fired("txn-1")
    r.mark_repayment_fired("txn-1")
    assert r.fired_repayments() == {"txn-1"}


def test_two_repayment_ids_coexist(shared):
    r = _repo(shared)
    r.mark_repayment_fired("txn-1")
    r.mark_repayment_fired("txn-2")
    assert r.fired_repayments() == {"txn-1", "txn-2"}


def test_repayment_markers_isolated_from_cycle_markers(shared):
    # The repayment set lives under its own pk, isolated from the per-cycle markers.
    r = _repo(shared)
    r.mark_fired("2026-07-01", 14, "groceries#80")
    r.mark_repayment_fired("txn-1")
    assert r.fired_repayments() == {"txn-1"}
    assert r.fired_markers("2026-07-01", 14) == {"groceries#80"}


def test_mark_repayment_writes_a_ttl(shared):
    r = _repo(shared)
    r.mark_repayment_fired("txn-1")
    item = r._table.store[("NOTIFY#REPAYMENT", "FIRED")]
    assert isinstance(item["expires_at"], int) and item["expires_at"] > 0


def test_mark_repayment_stamps_last_fired_at(shared):
    # WHIT-316: the balance-poller backstop reads this timestamp.
    r = _repo(shared)
    r.mark_repayment_fired("txn-1")
    item = r._table.store[("NOTIFY#REPAYMENT", "FIRED")]
    assert isinstance(item["last_fired_at"], int) and item["last_fired_at"] > 0


def test_last_repayment_fired_at_round_trips(shared):
    r = _repo(shared)
    r.mark_repayment_fired("txn-1")
    stamped = r._table.store[("NOTIFY#REPAYMENT", "FIRED")]["last_fired_at"]
    assert r.last_repayment_fired_at() == stamped


def test_last_repayment_fired_at_none_before_any_fire(shared):
    assert _repo(shared).last_repayment_fired_at() is None


def test_repayment_read_error_surfaces_as_database_error(shared, client_error, database_error):
    r = _repo(shared)

    def boom(**kwargs):
        raise client_error("InternalServerError")

    r._table.get_item = boom
    with pytest.raises(database_error):
        r.fired_repayments()


def test_repayment_mark_error_surfaces_as_database_error(shared, client_error, database_error):
    r = _repo(shared)

    def boom(**kwargs):
        raise client_error("InternalServerError")

    r._table.update_item = boom
    with pytest.raises(database_error):
        r.mark_repayment_fired("txn-1")


# --- repayment PUSH markers (WHIT-317): windowed amounts for the precise miss-detector ---


def test_no_push_amounts_before_any_push(shared):
    assert _repo(shared).repayment_push_amounts_since(0) == []


def test_push_amount_within_window_round_trips(shared):
    r = _repo(shared)
    r.mark_repayment_push(300000, "txn-1", fired_at=1000)
    assert r.repayment_push_amounts_since(500) == [300000]


def test_push_older_than_cutoff_is_excluded(shared):
    r = _repo(shared)
    r.mark_repayment_push(300000, "txn-1", fired_at=1000)
    assert r.repayment_push_amounts_since(2000) == []


def test_two_same_amount_pushes_both_count(shared):
    # Two distinct repayments of the same amount → two tokens (txn_id keeps them apart) →
    # the reader returns the amount twice, so both can be consumed by the detector.
    r = _repo(shared)
    r.mark_repayment_push(300000, "txn-1", fired_at=1000)
    r.mark_repayment_push(300000, "txn-2", fired_at=1001)
    assert sorted(r.repayment_push_amounts_since(500)) == [300000, 300000]


def test_push_marker_isolated_from_repayment_dedup(shared):
    r = _repo(shared)
    r.mark_repayment_fired("txn-1")
    r.mark_repayment_push(300000, "txn-1", fired_at=1000)
    assert r.fired_repayments() == {"txn-1"}
    assert r.repayment_push_amounts_since(0) == [300000]


def test_mark_push_writes_a_ttl(shared):
    r = _repo(shared)
    r.mark_repayment_push(300000, "txn-1", fired_at=1000)
    item = r._table.store[("NOTIFY#REPAYPUSH", "FIRED")]
    assert isinstance(item["expires_at"], int) and item["expires_at"] > 0


def test_push_read_error_surfaces_as_database_error(shared, client_error, database_error):
    r = _repo(shared)

    def boom(**kwargs):
        raise client_error("InternalServerError")

    r._table.get_item = boom
    with pytest.raises(database_error):
        r.repayment_push_amounts_since(0)


def test_push_mark_error_surfaces_as_database_error(shared, client_error, database_error):
    r = _repo(shared)

    def boom(**kwargs):
        raise client_error("InternalServerError")

    r._table.update_item = boom
    with pytest.raises(database_error):
        r.mark_repayment_push(300000, "txn-1")


# --- milestone markers (WHIT-301): once-ever, NO TTL ------------------------------------

def _milestone_repo(shared):
    return _repo(shared)


def test_no_milestones_fired_initially(shared):
    assert _milestone_repo(shared).fired_milestones() == set()


def test_mark_milestone_then_read_round_trips_as_strings(shared):
    r = _milestone_repo(shared)
    r.mark_milestone_fired("id:m1:bal:480000.00")  # WHIT-369 id-marker
    assert r.fired_milestones() == {"id:m1:bal:480000.00"}


def test_milestone_marks_accumulate_and_are_idempotent(shared):
    r = _milestone_repo(shared)
    r.mark_milestone_fired("0")
    r.mark_milestone_fired("1")
    r.mark_milestone_fired("0")  # re-mark harmless
    assert r.fired_milestones() == {"0", "1"}


def test_milestone_mark_writes_no_ttl(shared):
    # The update carries no expires_at, and the
    # stored item never grows a TTL attribute (a milestone must never expire + re-fire). The
    # shared-tenant default keeps the historical sk="FIRED" so WHIT-369 doesn't orphan existing
    # markers (which would re-fire on a non-monotonic balance).
    r = _milestone_repo(shared)
    r.mark_milestone_fired("0")
    _assert_no_ttl_written(r._table)
    stored = r._table.store[("NOTIFY#MILESTONE", "FIRED")]
    assert "expires_at" not in stored


def test_milestone_fired_state_is_scoped_by_owner(shared):
    # WHIT-369 multi-tenant seam: a marker written under one scope is invisible to another and
    # to the shared default, and lands under sk=<scope>. Today only the shared tenant is used;
    # this proves the seam is a per-owner key, so multi-user is a one-line poller change.
    r = _milestone_repo(shared)
    r.mark_milestone_fired("id:m1:bal:480000.00", scope="user-1")
    assert r.fired_milestones(scope="user-1") == {"id:m1:bal:480000.00"}
    assert r.fired_milestones(scope="user-2") == set()
    assert r.fired_milestones() == set()  # shared default untouched
    assert ("NOTIFY#MILESTONE", "user-1") in r._table.store


# --- reconcile: remove dead milestone markers (WHIT-385) --------------------------------

def test_remove_milestone_markers_drops_given_keys(shared):
    r = _milestone_repo(shared)
    r.mark_milestone_fired("bal:300000.00")
    r.mark_milestone_fired("bal:280000.00")
    r.mark_milestone_fired("0")
    r.remove_milestone_markers({"bal:300000.00"})
    assert r.fired_milestones() == {"bal:280000.00", "0"}


def test_remove_last_marker_drops_attribute_and_reads_empty(shared):
    # Deleting the last member drops the `fired` attribute entirely; the item survives and
    # fired_milestones() reads back an empty set.
    r = _milestone_repo(shared)
    r.mark_milestone_fired("bal:300000.00")
    r.remove_milestone_markers({"bal:300000.00"})
    stored = r._table.store[("NOTIFY#MILESTONE", "FIRED")]
    assert "fired" not in stored
    assert r.fired_milestones() == set()


def test_remove_milestone_markers_empty_is_a_noop(shared):
    # An empty key set must not touch the table — DynamoDB rejects an empty String Set.
    r = _milestone_repo(shared)

    def boom(**kwargs):
        raise AssertionError("update_item must not be called for an empty key set")

    r._table.update_item = boom
    r.remove_milestone_markers(set())  # no raise


def test_remove_milestone_markers_writes_no_ttl(shared):
    # The reconcile delete must preserve the no-TTL, once-ever contract: no #e/:exp on the
    # update, and the stored item never grows a TTL attribute.
    r = _milestone_repo(shared)
    r.mark_milestone_fired("bal:300000.00")
    r.mark_milestone_fired("bal:280000.00")
    r.remove_milestone_markers({"bal:300000.00"})
    _assert_no_ttl_written(r._table)
    stored = r._table.store[("NOTIFY#MILESTONE", "FIRED")]
    assert "expires_at" not in stored


def test_remove_milestone_markers_error_surfaces_as_database_error(shared, client_error, database_error):
    r = _milestone_repo(shared)

    def boom(**kwargs):
        raise client_error("InternalServerError")

    r._table.update_item = boom
    with pytest.raises(database_error):
        r.remove_milestone_markers({"bal:300000.00"})


# --- folded from test_repository_notify_gaps.py (WHIT-463) ---


_KEY = ("NOTIFY#REPAYMENT", "FIRED")


def test_last_fired_at_decimal_from_dynamo_returns_int(shared):
    # DynamoDB hands numbers back as Decimal.
    r = _repo(shared)
    r._table.seed({"pk": _KEY[0], "sk": _KEY[1], "last_fired_at": Decimal("1752000000")})
    result = r.last_repayment_fired_at()
    assert result == 1752000000
    assert type(result) is int  # not Decimal -> the int() cast is load-bearing


# --- folded from test_repository_notify_whit317_gaps.py (WHIT-463) ---


def test_push_exactly_at_cutoff_is_included(shared):
    # WHIT-317 — [A20] fired_at == cutoff is INSIDE the window (>=), not dropped.
    r = _repo(shared)
    r.mark_repayment_push(300000, "txn-1", fired_at=1000)
    assert r.repayment_push_amounts_since(1000) == [300000]


def test_push_one_second_below_cutoff_is_excluded(shared):
    # WHIT-317 — [A20] fired_at == cutoff-1 is OUTSIDE the window.
    r = _repo(shared)
    r.mark_repayment_push(300000, "txn-1", fired_at=999)
    assert r.repayment_push_amounts_since(1000) == []


def test_mixed_window_keeps_only_the_in_window_amounts(shared):
    # Three pushes straddling the cutoff → only the two at/after cutoff survive.
    r = _repo(shared)
    r.mark_repayment_push(100000, "a", fired_at=500)   # out
    r.mark_repayment_push(200000, "b", fired_at=1000)  # in (==cutoff)
    r.mark_repayment_push(300000, "c", fired_at=1500)  # in
    assert sorted(r.repayment_push_amounts_since(1000)) == [200000, 300000]


def test_hash_in_txn_id_does_not_corrupt_amount(shared):
    # split('#', 2) caps at 2 splits → the amount field is always the 2nd token, even
    # if the id itself carries '#'. Up ids are UUIDs (no '#'), but the maxsplit is the
    # only thing protecting the amount, so prove it.
    r = _repo(shared)
    r.mark_repayment_push(357300, "weird#id#with#hashes", fired_at=1000)
    assert r.repayment_push_amounts_since(0) == [357300]


# --- goal-checkpoint markers (WHIT-479): once-ever, NO TTL, own item -----------------------
# Same `ADD #f :m` String-Set update as the milestones, no TTL — but keyed under
# NOTIFY#GOALCHECKPOINT, a SEPARATE item from NOTIFY#MILESTONE so the mortgage feature is untouched.

def _goalcheckpoint_repo(shared):
    return _repo(shared)


def test_no_goal_checkpoints_fired_initially(shared):
    assert _goalcheckpoint_repo(shared).fired_goal_checkpoints() == set()


def test_mark_goal_checkpoint_then_read_round_trips(shared):
    r = _goalcheckpoint_repo(shared)
    r.mark_goal_checkpoint_fired("g:g1:cp:cp1:bal:5000.00")
    assert r.fired_goal_checkpoints() == {"g:g1:cp:cp1:bal:5000.00"}


def test_goal_checkpoint_marks_accumulate_and_are_idempotent(shared):
    r = _goalcheckpoint_repo(shared)
    r.mark_goal_checkpoint_fired("g:g1:cp:a:bal:1000.00")
    r.mark_goal_checkpoint_fired("g:g1:cp:b:bal:2000.00")
    r.mark_goal_checkpoint_fired("g:g1:cp:a:bal:1000.00")  # re-mark harmless
    assert r.fired_goal_checkpoints() == {"g:g1:cp:a:bal:1000.00", "g:g1:cp:b:bal:2000.00"}


def test_goal_checkpoint_mark_writes_no_ttl(shared):
    # A crossing is once-ever (the balance isn't monotonic), so the marker must never expire.
    r = _goalcheckpoint_repo(shared)
    r.mark_goal_checkpoint_fired("g:g1:cp:a:bal:1000.00")
    _assert_no_ttl_written(r._table)
    stored = r._table.store[("NOTIFY#GOALCHECKPOINT", "FIRED")]
    assert "expires_at" not in stored


def test_goal_checkpoint_markers_are_a_separate_item_from_milestones(shared):
    # The goal-checkpoint set must NOT collide with the mortgage milestone set.
    r = _goalcheckpoint_repo(shared)
    r.mark_goal_checkpoint_fired("g:g1:cp:a:bal:1000.00")
    r.mark_milestone_fired("0")
    assert ("NOTIFY#GOALCHECKPOINT", "FIRED") in r._table.store
    assert ("NOTIFY#MILESTONE", "FIRED") in r._table.store
    assert r.fired_goal_checkpoints() == {"g:g1:cp:a:bal:1000.00"}
    assert r.fired_milestones() == {"0"}
