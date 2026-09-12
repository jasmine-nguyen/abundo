"""WHIT-531 gap coverage — FakeRuleRepo must stay behaviourally faithful to the REAL
RuleRepository (shared/repository_rule.py).

The four apply-rules suites drive FakeRuleRepo as a stand-in for RuleRepository. If the fake
drifts from the real store's dedup / clash / id contract, every one of those suites keeps passing
against a lie. This pins the contract: the SAME sequence of create_rule/list_rules calls, driven
against BOTH the fake and a real RuleRepository (backed by the conftest FakeTable that honours the
attribute_not_exists guard), must agree on:
  * the (rule, created) tuple's handler-relevant projection (id/field/operator/value/category_id);
  * the derived id (rule_engine.rule_id_for — the one place a drift could creep in);
  * RuleClashError semantics (same-text/different-category raises, carrying the same existing row).

Not covered by test_repository_rule.py (real repo only) nor the apply-rules suites (fake only) —
this is the CROSS-check neither side does. Imports FakeRuleRepo to test it; the real repo comes
from the shared conftest `rule_repo` fixture.
"""

import pytest

from _rule_fakes import FakeRuleRepo


# Handler-relevant projection: the exact keys _rule_to_client reads. The real repo's row also
# carries pk/sk/source/created_at/updated_at, which the handler never maps — so the contract is
# equality on THIS slice, not the whole row.
_KEYS = ("id", "field", "operator", "value", "category_id")


def _project(row):
    return {k: row.get(k) for k in _KEYS}


def _fake():
    return FakeRuleRepo()


def test_fake_and_real_agree_on_create_dedup_and_the_projection(rule_repo):
    # Same text + same category, created twice, against both stores. Both must report
    # created True then False, the SAME id, and an equal projection.
    fake = _fake()
    args = ("description", "contains", "COLES", "groceries")

    fake_first, fake_created1 = fake.create_rule(*args)
    real_first, real_created1 = rule_repo.create_rule(*args)
    fake_second, fake_created2 = fake.create_rule(*args)
    real_second, real_created2 = rule_repo.create_rule(*args)

    assert (fake_created1, fake_created2) == (True, False) == (real_created1, real_created2)
    assert _project(fake_first) == _project(real_first)
    assert fake_first["id"] == real_first["id"]           # id derivation agrees
    assert fake_second["id"] == real_second["id"] == real_first["id"]
    assert len(fake.list_rules()) == len(rule_repo.list_rules()) == 1


def test_fake_and_real_agree_on_the_clash_and_its_existing_row(rule_repo):
    # Same text, DIFFERENT category: both must raise RuleClashError carrying the existing rule.
    from repository_errors import RuleClashError

    fake = _fake()
    fake.create_rule("description", "contains", "COLES", "groceries")
    rule_repo.create_rule("description", "contains", "COLES", "groceries")

    with pytest.raises(RuleClashError) as fake_err:
        fake.create_rule("description", "contains", "COLES", "petrol")
    with pytest.raises(RuleClashError) as real_err:
        rule_repo.create_rule("description", "contains", "COLES", "petrol")

    assert _project(fake_err.value.existing) == _project(real_err.value.existing)
    assert fake_err.value.existing["category_id"] == "groceries"      # the winner, not petrol
    # The clashing write left nothing behind in either store.
    assert len(fake.list_rules()) == len(rule_repo.list_rules()) == 1


def test_fake_and_real_dedup_case_and_spacing_variants_identically(rule_repo):
    # The fold-based id is the dedup key. "coles online" and "  COLES   ONLINE  " must collapse
    # onto one row in BOTH stores — a fake that compared raw text would over-mint.
    fake = _fake()
    fake.create_rule("description", "contains", "coles online", "groceries")
    real_row, _ = rule_repo.create_rule("description", "contains", "coles online", "groceries")

    _, fake_created = fake.create_rule("description", "contains", "  COLES   ONLINE  ", "groceries")
    dupe_row, real_created = rule_repo.create_rule(
        "description", "contains", "  COLES   ONLINE  ", "groceries")

    assert fake_created is False and real_created is False
    assert dupe_row["id"] == real_row["id"]
    assert len(fake.list_rules()) == len(rule_repo.list_rules()) == 1


def test_fake_and_real_agree_on_in_place_update(rule_repo):
    # A category-only edit keeps the id (the id is the TEXT), updates in place, and returns the
    # new category. Both stores must agree and end with exactly one row.
    fake = _fake()
    args = ("description", "contains", "COLES", "groceries")
    fake_created, _ = fake.create_rule(*args)
    real_created, _ = rule_repo.create_rule(*args)

    fake_updated = fake.update_rule(fake_created["id"], "description", "contains", "COLES", "petrol")
    real_updated = rule_repo.update_rule(real_created["id"], "description", "contains", "COLES",
                                         "petrol")

    assert _project(fake_updated) == _project(real_updated)
    assert fake_updated["id"] == real_updated["id"] == fake_created["id"]   # id unchanged
    assert fake_updated["category_id"] == "petrol"
    assert len(fake.list_rules()) == len(rule_repo.list_rules()) == 1


def test_fake_and_real_agree_on_a_text_edit_moving_the_id(rule_repo):
    # Editing the VALUE changes the derived id: the row moves to the new id and the old id is gone.
    # Exactly one row survives in both stores, and the returned rule carries the new id.
    fake = _fake()
    args = ("description", "contains", "COLES", "groceries")
    fake_created, _ = fake.create_rule(*args)
    real_created, _ = rule_repo.create_rule(*args)
    old_id = fake_created["id"]

    fake_moved = fake.update_rule(old_id, "description", "contains", "COLES EXPRESS", "groceries")
    real_moved = rule_repo.update_rule(old_id, "description", "contains", "COLES EXPRESS",
                                       "groceries")

    assert _project(fake_moved) == _project(real_moved)
    assert fake_moved["id"] == real_moved["id"] != old_id
    fake_ids = {r["id"] for r in fake.list_rules()}
    real_ids = {r["id"] for r in rule_repo.list_rules()}
    assert fake_ids == real_ids == {fake_moved["id"]}       # old id gone in both
    assert len(fake.list_rules()) == len(rule_repo.list_rules()) == 1


def test_fake_and_real_refuse_an_edit_onto_another_rules_text(rule_repo):
    # Editing rule A's text onto rule B's text would merge two rules — both stores refuse with a
    # RuleClashError carrying B (the existing rule), leaving both rows intact.
    from repository_errors import RuleClashError

    fake = _fake()
    for store in (fake, rule_repo):
        store.create_rule("description", "contains", "COLES", "groceries")
        store.create_rule("description", "contains", "WOOLWORTHS", "groceries")

    a_id = rule_engine_id("description", "contains", "COLES")

    with pytest.raises(RuleClashError) as fake_err:
        fake.update_rule(a_id, "description", "contains", "WOOLWORTHS", "groceries")
    with pytest.raises(RuleClashError) as real_err:
        rule_repo.update_rule(a_id, "description", "contains", "WOOLWORTHS", "groceries")

    assert _project(fake_err.value.existing) == _project(real_err.value.existing)
    assert fake_err.value.existing["value"] == "WOOLWORTHS"      # B, the rule edited onto
    assert len(fake.list_rules()) == len(rule_repo.list_rules()) == 2


def test_fake_and_real_raise_not_found_editing_an_unknown_id(rule_repo):
    from repository_errors import RuleNotFoundError

    fake = _fake()
    with pytest.raises(RuleNotFoundError):
        fake.update_rule("deadbeef", "description", "contains", "COLES", "groceries")
    with pytest.raises(RuleNotFoundError):
        rule_repo.update_rule("deadbeef", "description", "contains", "COLES", "groceries")


def test_fake_and_real_delete_is_idempotent(rule_repo):
    # Delete, then delete again: both succeed (no raise) and leave zero rows. This is the contract
    # the idempotent HTTP DELETE relies on.
    fake = _fake()
    args = ("description", "contains", "COLES", "groceries")
    fake_created, _ = fake.create_rule(*args)
    real_created, _ = rule_repo.create_rule(*args)

    for store, created in ((fake, fake_created), (rule_repo, real_created)):
        store.delete_rule(created["id"])
        store.delete_rule(created["id"])       # second delete is a no-op, not an error
        assert store.list_rules() == []


def rule_engine_id(field, operator, value):
    import rule_engine
    return rule_engine.rule_id_for(field, operator, value)


def test_fake_and_real_list_rules_return_the_same_projected_rows(rule_repo):
    # After the same seeding, list_rules must return the same set of projected rows (order-free:
    # the handler maps and sweeps the whole list, it does not depend on order).
    fake = _fake()
    seeds = [("description", "contains", "COLES", "groceries"),
             ("description", "contains", "BP 2210", "petrol"),
             ("category", "equals", "FOOD_AND_DRINK", "groceries")]
    for seed in seeds:
        fake.create_rule(*seed)
        rule_repo.create_rule(*seed)

    fake_rows = sorted((_project(r) for r in fake.list_rules()), key=lambda r: r["id"])
    real_rows = sorted((_project(r) for r in rule_repo.list_rules()), key=lambda r: r["id"])

    assert fake_rows == real_rows
    assert len(fake_rows) == 3
