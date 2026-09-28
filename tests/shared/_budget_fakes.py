"""The REAL BudgetRepository over a FakeTable for the budget endpoint suites (WHIT-625).

``recording_budget_repo`` is ``_category_fakes.budget_repo`` (the real repository over its own
seeded FakeTable) plus a spy on each method the handlers call: the call is recorded, then the REAL
method runs. So the merge, the rollover/spread strips, the version lock and the delete no-op are
production's, and a test can still assert what the handler asked for. Read the stored entries back
with ``stored_budgets``.

Resolved by pytest.ini's `pythonpath = tests/shared`. The shared layer is imported lazily (inside
``budget_repo``), so inside a ``handler``-style fixture it comes from the freshly loaded copy.
"""

from _category_fakes import budget_repo, stored_budgets

__all__ = ["recording_budget_repo", "stored_budgets"]


def recording_budget_repo(budgets=None):
    """The real BudgetRepository holding ``budgets`` ({id: entry}), recording its calls in
    ``list_calls`` (a count), ``set_calls`` ((id, target)), ``set_kwargs`` (the last set_budget's
    rollover/anchor), ``settle_calls``, ``set_spread_calls``, ``clear_spread_calls`` and
    ``delete_calls``."""
    repo = budget_repo(budgets)
    real_list = repo.list_budgets
    real_set = repo.set_budget
    real_settle = repo.settle_carryover
    real_set_spread = repo.set_spread
    real_clear_spread = repo.clear_spread
    real_delete = repo.delete_budget

    repo.list_calls = 0
    repo.set_calls = []
    repo.set_kwargs = None
    repo.settle_calls = []
    repo.set_spread_calls = []
    repo.clear_spread_calls = []
    repo.delete_calls = []

    def list_budgets():
        repo.list_calls += 1
        return real_list()

    def set_budget(cat_id, target, rollover=None, anchor=None):
        repo.set_calls.append((cat_id, target))
        repo.set_kwargs = {"rollover": rollover, "anchor": anchor}
        return real_set(cat_id, target, rollover=rollover, anchor=anchor)

    def settle_carryover(cat_id, carryover, carryover_from, carryover_len, carryover_paydate):
        repo.settle_calls.append((cat_id, carryover, carryover_from, carryover_len, carryover_paydate))
        return real_settle(cat_id, carryover, carryover_from, carryover_len, carryover_paydate)

    def set_spread(cat_id, amount, cycles, spread_from, spread_len, spread_paydate):
        repo.set_spread_calls.append((cat_id, amount, cycles, spread_from, spread_len, spread_paydate))
        return real_set_spread(cat_id, amount, cycles, spread_from, spread_len, spread_paydate)

    def clear_spread(cat_id):
        repo.clear_spread_calls.append(cat_id)
        return real_clear_spread(cat_id)

    def delete_budget(cat_id):
        repo.delete_calls.append(cat_id)
        return real_delete(cat_id)

    repo.list_budgets = list_budgets
    repo.set_budget = set_budget
    repo.settle_carryover = settle_carryover
    repo.set_spread = set_spread
    repo.clear_spread = clear_spread
    repo.delete_budget = delete_budget
    return repo
