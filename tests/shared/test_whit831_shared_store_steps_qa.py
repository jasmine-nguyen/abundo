"""QA for WHIT-831 slice 2: the stores' shared save / read / add-remove steps keep each caller's
behaviour — the error label of every converted conditional save, the delete marker, the notify
expiry clock, the lost seed race and the loan-facts save reply."""

from decimal import Decimal

import pytest

from _dynamo_fakes import FakeTable

_PK, _SK = "ACCOUNT#acc", "TXN#gone"

# (method, call on an EMPTY table, error label). On an empty table every save is refused → False.
_TRANSACTION_SAVES = [
    ("delete_transaction", lambda r: r.delete_transaction(_PK, _SK), "delete_item", "delete"),
    ("delete_if_still_pending", lambda r: r.delete_if_still_pending(_PK, _SK), "delete_item", "delete"),
    ("carry_onto_pending", lambda r: r.carry_onto_pending(_PK, _SK, {"category": "groceries"}),
     "update_item", "write"),
    ("update_transaction_category", lambda r: r.update_transaction_category(_PK, _SK, "groceries"),
     "update_item", "write"),
    ("clear_rule_fill", lambda r: r.clear_rule_fill(_PK, _SK, "rule-1"), "update_item", "write"),
    ("refile_rule_fill", lambda r: r.refile_rule_fill(_PK, _SK, "groceries", "rule-1", "rule-2"),
     "update_item", "write"),
    ("update_transaction_fields", lambda r: r.update_transaction_fields(_PK, _SK, notes="hi"),
     "update_item", "write"),
]


# [A1] (P0)
@pytest.mark.parametrize("name, call, operation, label", _TRANSACTION_SAVES,
                         ids=[row[0] for row in _TRANSACTION_SAVES])
def test_each_conditional_save_says_false_when_refused_and_names_its_action_on_a_fault(
        repo, client_error, database_error, name, call, operation, label):
    assert call(repo) is False

    repo._table.fail(operation, client_error("InternalServerError", "down"))
    with pytest.raises(database_error, match=f"^Database {label} failed: down$"):
        call(repo)


# [A2] (P1)
def test_mark_rule_spread_fault_names_its_action(rule_repo, client_error, database_error):
    rule, _ = rule_repo.create_rule("description", "contains", "COLES", "groceries")
    rule_repo._table.fail("update_item", client_error("InternalServerError", "down"))
    with pytest.raises(database_error, match="^Database mark rule spread failed: down$"):
        rule_repo.mark_spread_seeded(rule["id"])


# [A3] (P0)
def test_delete_marker_fault_is_a_delete_error_and_the_row_survives(repo, client_error, database_error):
    repo._table.seed({"pk": _PK, "sk": _SK, "status": "posted"})
    repo._table.fail("put_item", client_error("InternalServerError", "down"))
    with pytest.raises(database_error, match="^Database delete failed: down$"):
        repo.delete_transaction(_PK, _SK)
    assert (_PK, _SK) in repo._table.store


# [A4] (P0)
def test_repayment_push_token_and_expiry_come_from_one_clock_read(shared, monkeypatch):
    import repository_notify
    from constants import NOTIFY_TTL_SECONDS

    ticks = iter(range(1_000_000, 1_000_100))
    monkeypatch.setattr(repository_notify.time, "time", lambda: next(ticks))
    notify = shared.notify.NotifyRepository()
    notify._table = FakeTable()

    notify.mark_repayment_push(12345, "txn-1")
    item = next(iter(notify._table.store.values()))
    (token,) = item["pushes"]
    assert item["expires_at"] == int(token.split("#")[0]) + NOTIFY_TTL_SECONDS


# [A5] (P1)
@pytest.mark.parametrize("mark", [
    lambda n: n.mark_fired("2026-10-01", 14, "groceries#80"),
    lambda n: n.claim_fired("2026-10-01", 14, "groceries#80"),
], ids=["mark_fired", "claim_fired"])
def test_budget_alert_markers_expire_ttl_seconds_after_now(shared, monkeypatch, mark):
    import repository_notify
    from constants import NOTIFY_TTL_SECONDS

    monkeypatch.setattr(repository_notify.time, "time", lambda: 1_000_000.7)
    notify = shared.notify.NotifyRepository()
    notify._table = FakeTable()

    mark(notify)
    item = next(iter(notify._table.store.values()))
    assert item["expires_at"] == 1_000_000 + NOTIFY_TTL_SECONDS
    assert item["fired"] == {"groceries#80"}


# (module, class, read, racer's extra fields, what the read must return)
_SEEDED_READS = [
    ("repository_budget", "BudgetRepository", lambda r: r.list_budgets(),
     {"items": {"food": {"target": Decimal(50)}}}, {"food": {"target": Decimal(50)}}),
    ("repository_goals", "GoalsRepository", lambda r: r.list_goals(),
     {"items": {"g1": {"name": "Trip"}}}, {"g1": {"name": "Trip"}}),
    ("repository_paycycle", "PayCycleRepository", lambda r: r.get_paycycle(),
     {"length": Decimal(7), "last_pay_date": "2026-09-30"}, {"length": 7, "last_pay_date": "2026-09-30"}),
]


# [A6] (P0)
@pytest.mark.parametrize("module_name, class_name, read, racer_fields, expected", _SEEDED_READS,
                         ids=[row[1] for row in _SEEDED_READS])
def test_first_read_that_loses_the_seed_race_returns_the_winners_record(
        shared, module_name, class_name, read, racer_fields, expected):
    import importlib

    store = getattr(importlib.import_module(module_name), class_name)()
    table = FakeTable()
    store._table = table
    racer = {**store._config_key, **racer_fields, "version": Decimal(2)}
    real_put = table.put_item

    def put_after_the_racer(**kwargs):
        table.seed(racer)   # another caller seeded between our read and our seed
        return real_put(**kwargs)

    table.put_item = put_after_the_racer

    assert read(store) == expected
    assert table.store[(racer["pk"], racer["sk"])]["version"] == Decimal(2)


# [A7] (P1)
@pytest.mark.parametrize("optional", [
    {},
    {"payoffGoalDate": "2035-06-01", "depositTarget": Decimal("120000")},
], ids=["required-only", "with-optionals"])
def test_save_loan_facts_replies_with_exactly_what_a_read_returns(loanfacts_repo, optional):
    saved = loanfacts_repo.set_loanfacts(
        original=Decimal("600000"), homeValue=Decimal("770000"), lvr=Decimal("0.8"),
        ratePct=Decimal("5.74"), baseRepay=Decimal("1240"), extra=Decimal("0"), **optional,
    )
    assert saved == loanfacts_repo.get_loanfacts()
    assert all(type(saved[field]) is float for field in ("original", "lvr", "extra"))
