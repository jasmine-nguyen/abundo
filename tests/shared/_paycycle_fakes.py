"""Shared handler-level fake for the pay-cycle suites.

The impl suite tests/lambda_api/test_paycycle.py and the parity gap suite
test_paycycle_parity.py both stand in for PayCycleRepository at the handler level. They
live here, in ONE definition, so both `import` it instead of copying (WHIT-445). This is
the richer of the two shapes (records get/set calls and can raise a version conflict); the
parity suite constructs it with `cycle=` and reads only get_paycycle, ignoring the recorders.

NOTE: the breakdown/budgets suites carry a DIFFERENTLY-SHAPED FakePayCycleRepo
(`__init__(length=, last_pay_date=)`, no set_paycycle) — a separate fake that merely shares
the name, not consolidated here.

Resolved by pytest.ini's `pythonpath = tests/shared`. Pure stdlib, no shared/-layer import.
"""


class FakePayCycleRepo:
    """Handler-level stand-in for PayCycleRepository (records calls)."""

    def __init__(self, cycle=None, conflict_exc=None):
        self._cycle = cycle or {"length": 14, "last_pay_date": "2024-01-03"}
        self._conflict_exc = conflict_exc
        self.set_calls = []
        self.get_calls = 0

    def get_paycycle(self):
        self.get_calls += 1
        return dict(self._cycle)

    def set_paycycle(self, length, last_pay_date):
        self.set_calls.append((length, last_pay_date))
        if self._conflict_exc is not None:
            raise self._conflict_exc("boom")
        return {"length": length, "last_pay_date": last_pay_date}
