"""Shared fakes + helpers for the goal-nudge suites (WHIT-258).

The behind-pace nudge tests (``test_goal_nudge.py`` + ``test_goal_nudge_edges.py``) both
drive ``shared/goal_nudge.notify_behind_goals`` through in-memory repo fakes. These were
copy-pasted into both files and had already drifted (counters, ``seed=``, ``_run`` arity), so
this is the single source — the SUPERSET that satisfies both suites. Leading underscore keeps
pytest (``python_files = test_*.py``) from collecting it as a test module; ``pythonpath =
tests/shared`` in pytest.ini makes it importable by both suites.

Fortnightly cycle, paydays land …Jul4, Jul18, Aug1, Aug15; "today" = Sat 11 Jul 2026.
"""

from datetime import date
from decimal import Decimal

CYCLE = {"length": 14, "last_pay_date": "2026-06-06"}
TODAY = date(2026, 7, 11)


class FakeGoalsRepo:
    def __init__(self, goals):
        self._goals = goals  # {goal_id: goal}

    def list_goals(self):
        return dict(self._goals)


class FakeDeviceRepo:
    def __init__(self, tokens=("tok-1",)):
        self._tokens = list(tokens)
        self.calls = 0

    def list_tokens(self):
        self.calls += 1
        return list(self._tokens)


class FakePayCycleRepo:
    def __init__(self, cycle=CYCLE):
        self._cycle = cycle
        self.calls = 0

    def get_paycycle(self):
        self.calls += 1
        return dict(self._cycle)


class FakeBalanceRepo:
    def __init__(self, balances):
        self._balances = balances  # {account_id: signed Decimal amount}
        self.requested = None

    def list_balances(self, account_ids):
        self.requested = list(account_ids)
        return [{"account_id": a, "amount": self._balances[a]} for a in account_ids if a in self._balances]


class FakeNotifyRepo:
    """Mirrors the SHARED FIRED set: goal + budget markers share one per-cycle partition.
    `seed` pre-loads markers ({(last_pay_date, length): {markers}}) — used by the
    budget-marker-collision test."""

    def __init__(self, seed=None):
        self.store = {}  # (last_pay_date, length) -> set of markers
        if seed:
            for (last_pay_date, length), markers in seed.items():
                self.store[(last_pay_date, length)] = set(markers)

    def fired_markers(self, last_pay_date, length):
        return set(self.store.get((last_pay_date, length), set()))

    def mark_fired(self, last_pay_date, length, marker):
        self.store.setdefault((last_pay_date, length), set()).add(marker)


class SendRecorder:
    """Stub for goal_nudge.send_push — records each call, returns {sent, ok, pruned}."""

    def __init__(self, ok=1):
        self._ok = ok
        self.calls = []

    def __call__(self, title, body, tokens):
        self.calls.append({"title": title, "body": body, "tokens": list(tokens)})
        return {"sent": len(tokens), "ok": self._ok if tokens else 0, "pruned": 0}


def _grow(**over):
    goal = {"name": "Holiday fund", "direction": "grow", "target_amount": Decimal(10000),
            "target_date": "2026-07-18", "account_id": "up-spending"}
    goal.update(over)
    return goal


def _manual(**over):
    """A MANUAL goal (no linked account) — its balance is whatever the user last typed, as of
    manual_as_of. Far target_date + a 71-day-old balance by default, so it's stale but NOT
    behind, keeping the two triggers separable in tests."""
    goal = {"name": "Car savings", "direction": "grow", "target_amount": Decimal(10000),
            "target_date": "2026-12-01", "account_id": None,
            "manual_balance": Decimal(4000), "manual_as_of": "2026-05-01"}
    goal.update(over)
    return goal


def _run(shared, monkeypatch, goals, *, balances=None, tokens=("tok-1",), notify=None,
         send_ok=1, today=TODAY, cycle=CYCLE):
    """Wire the fakes into notify_behind_goals and return
    (sent, recorder, notify, device, paycycle, balance_repo). Suites that only need the first
    few unpack with a trailing ``*_``."""
    recorder = SendRecorder(ok=send_ok)
    monkeypatch.setattr(shared.goal_nudge, "send_push", recorder)
    notify = notify if notify is not None else FakeNotifyRepo()
    device = FakeDeviceRepo(tokens)
    paycycle = FakePayCycleRepo(cycle)
    balance_repo = FakeBalanceRepo(balances or {})
    sent = shared.goal_nudge.notify_behind_goals(
        goals_repo=FakeGoalsRepo(goals), balance_repo=balance_repo, paycycle_repo=paycycle,
        device_repo=device, notify_repo=notify, today=today,
    )
    return sent, recorder, notify, device, paycycle, balance_repo
