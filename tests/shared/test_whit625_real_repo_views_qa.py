"""WHIT-625 slice 3 QA — the helper views the migrated suites assert through really see what the
real repositories write.

The milestone / budget-alert / category / pay-cycle suites no longer read a fake's own fields;
they read the FakeTable through small views (``stored_markers``, ``removed_markers``,
``released_markers``, ``stored_budgets``, ``stored_cycle``, ...). Many of their assertions are
negative (``== set()``, ``not in``). If a view looked at the wrong key, those would pass whatever
production did. These tests pin each view to the key and shape the REAL repository uses, so a
drift between the two reddens here instead of silently voiding the suites.
"""

from decimal import Decimal

import pytest
from _budget_alert_fakes import claimed_meanwhile, fail_nth_write, notify_repo as alert_notify_repo
from _budget_alert_fakes import released_markers
from _category_fakes import budget_repo, stored_budgets
from _milestone_fakes import (
    marker_reads, notify_repo, removal_calls, removed_markers, scopes_marked, scopes_read,
    stored_markers,
)
from _paycycle_fakes import paycycle_repo, stored_cycle

_CYCLE = ("2026-07-01", 14)


# --- milestone markers ------------------------------------------------------------------------


def test_seeded_and_new_milestone_markers_are_what_the_views_and_the_real_read_see(shared):
    # [A1] the views read the partition the real repository writes; a drifted pk would leave
    # stored_markers empty and every "== set()" / "not in" assertion vacuous.
    notify = notify_repo(fired={"0", "id:a:bal:300000.00"})
    notify.mark_milestone_fired("1")

    assert stored_markers(notify) == {"0", "1", "id:a:bal:300000.00"}
    assert notify.fired_milestones() == stored_markers(notify)


def test_setup_marks_are_not_counted_as_the_code_under_test(shared):
    # [A1] notify_repo's seeding goes through real writes; the views must not report them.
    notify = notify_repo(fired={"0"})

    assert scopes_marked(notify) == []
    assert removal_calls(notify) == 0
    assert marker_reads(notify) == 0


def test_removed_markers_leave_the_set_and_are_reported(shared):
    # [A2]
    notify = notify_repo(fired={"0", "id:gone:bal:1.00"})

    notify.remove_milestone_markers({"id:gone:bal:1.00"})

    assert removed_markers(notify) == {"id:gone:bal:1.00"}
    assert removal_calls(notify) == 1
    assert stored_markers(notify) == {"0"}


def test_an_empty_removal_never_reaches_the_table(shared):
    # [A2] the old fake asserted callers never removed an empty set. That guard now lives in the
    # real repository, and FakeTable would accept an empty DELETE that DynamoDB rejects — so pin it.
    notify = notify_repo(fired={"0"})

    notify.remove_milestone_markers(set())

    assert removal_calls(notify) == 0
    assert stored_markers(notify) == {"0"}


def test_scope_views_name_the_owner_and_owners_stay_separate(shared):
    # [A3] the shared tenant is "FIRED"; a per-user scope is its own set.
    notify = notify_repo()

    notify.mark_milestone_fired("0")
    notify.mark_milestone_fired("1", scope="user-1")
    shared_set = notify.fired_milestones()
    user_set = notify.fired_milestones(scope="user-1")

    assert scopes_marked(notify) == ["FIRED", "user-1"]
    assert scopes_read(notify) == ["FIRED", "user-1"]
    assert (shared_set, user_set) == ({"0"}, {"1"})


# --- budget-alert markers ---------------------------------------------------------------------


def test_claim_only_wins_an_absent_marker_and_release_reopens_it(shared):
    # [A4] the conditional claim runs as production wrote it over the shared FakeTable.
    notify = alert_notify_repo()

    first = notify.claim_fired(*_CYCLE, "groceries#80")
    second = notify.claim_fired(*_CYCLE, "groceries#80")
    notify.release_fired(*_CYCLE, "groceries#80")
    again = notify.claim_fired(*_CYCLE, "groceries#80")

    assert (first, second, again) == (True, False, True)
    assert released_markers(notify) == ["groceries#80"]
    assert notify.fired_markers(*_CYCLE) == {"groceries#80"}


def test_claim_in_one_cycle_does_not_block_the_next(shared):
    # [A4]
    notify = alert_notify_repo()
    notify.mark_fired(*_CYCLE, "groceries#80")

    assert notify.claim_fired("2026-07-15", 14, "groceries#80") is True
    assert notify.fired_markers("2026-07-15", 14) == {"groceries#80"}


def test_fail_nth_write_fails_only_the_nth_write_of_that_verb(shared):
    # [A5] a release (DELETE) in between doesn't count towards the ADD tally.
    import repository_errors
    notify = alert_notify_repo()
    fail_nth_write(notify, "ADD", 2)

    assert notify.claim_fired(*_CYCLE, "a#80") is True
    notify.release_fired(*_CYCLE, "a#80")
    with pytest.raises(repository_errors.DatabaseError):
        notify.claim_fired(*_CYCLE, "b#80")
    assert notify.claim_fired(*_CYCLE, "c#80") is True
    assert notify.fired_markers(*_CYCLE) == {"c#80"}


def test_a_marker_claimed_meanwhile_loses_this_delivery_the_claim(shared):
    # [A6] the other delivery's claim lands after this one's read, just before its write.
    notify = alert_notify_repo()
    assert notify.fired_markers(*_CYCLE) == set()          # this delivery's snapshot
    claimed_meanwhile(notify, *_CYCLE, "coffee#100")

    assert notify.claim_fired(*_CYCLE, "coffee#100") is False
    assert notify.fired_markers(*_CYCLE) == {"coffee#100"}


# --- budgets ----------------------------------------------------------------------------------


_SPREAD = {"spread_amount": Decimal(100), "spread_cycles": Decimal(4), "spread_from": "2026-07-01",
           "spread_len": Decimal(14), "spread_paydate": "2026-07-01"}


def test_budget_repo_seed_is_what_the_real_repository_lists(shared):
    # [A7]
    repo = budget_repo({"coffee": {"target": Decimal(58)}, "rent": {"target": Decimal(900)}})

    assert repo.list_budgets() == {"coffee": {"target": Decimal(58)}, "rent": {"target": Decimal(900)}}


def test_real_delete_and_clear_show_in_stored_budgets(shared):
    # [A7] other ids are untouched; the clear keeps the target.
    repo = budget_repo({"coffee": {"target": Decimal(58), **_SPREAD}, "rent": {"target": Decimal(900)}})

    repo.clear_spread("coffee")
    repo.delete_budget("rent")

    assert stored_budgets(repo) == {"coffee": {"target": Decimal(58)}}


def test_budget_version_race_is_retried_once_then_lands(shared):
    # [A7] a single lost race is retried by the real code, not reported as a conflict.
    repo = budget_repo({"coffee": {"target": Decimal(58)}})
    repo._table.race_next_update()

    repo.delete_budget("coffee")

    assert stored_budgets(repo) == {}
    assert len(repo._table.update_calls) == 2


# --- pay cycle --------------------------------------------------------------------------------


def test_paycycle_seed_is_what_the_real_repository_reads(shared):
    # [A8]
    table, repo = paycycle_repo({"length": 7, "last_pay_date": "2026-07-03"})

    assert repo.get_paycycle() == {"length": 7, "last_pay_date": "2026-07-03"}
    assert stored_cycle(table) == (7, "2026-07-03")


def test_an_empty_paycycle_table_gets_the_production_default(shared):
    # [A8] paycycle_repo() leaves the table empty, so the handler suites run on the real seed.
    from constants import DEFAULT_PAYCYCLE
    table, repo = paycycle_repo()
    assert stored_cycle(table) is None

    assert repo.get_paycycle() == {"length": DEFAULT_PAYCYCLE["length"],
                                   "last_pay_date": DEFAULT_PAYCYCLE["last_pay_date"]}
    assert stored_cycle(table) == (DEFAULT_PAYCYCLE["length"], DEFAULT_PAYCYCLE["last_pay_date"])


def test_set_paycycle_replaces_the_stored_cycle(shared):
    # [A8]
    table, repo = paycycle_repo({"length": 14, "last_pay_date": "2026-07-01"})

    repo.set_paycycle(30, "2026-07-10")

    assert stored_cycle(table) == (30, "2026-07-10")
    assert table.store[("PAYCYCLE", "PAYCYCLE")]["version"] == 2
