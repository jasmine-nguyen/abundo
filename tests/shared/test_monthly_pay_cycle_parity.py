"""ABU-44 parity: the server's pay-cycle clock (shared/spend.py) must match the app's
(src/payCycle.ts) for the same dates. Both this test and
src/__tests__/monthlyPayCycleParity.logic.test.ts check the same fixture
(tests/fixtures/monthly_pay_cycle_parity.json), so drift on either side fails."""

import json
import pathlib
from datetime import date

_FIXTURE = pathlib.Path(__file__).resolve().parents[1] / "fixtures" / "monthly_pay_cycle_parity.json"


def test_the_server_pay_cycle_clock_reproduces_the_parity_fixture(shared):
    for case in json.loads(_FIXTURE.read_text())["cases"]:
        today = date.fromisoformat(case["today"])
        start, _ = shared.spend.current_cycle_window(case["last_pay_date"], case["length"], today)
        clock = shared.spend.cycle_clock(case["last_pay_date"], case["length"], today)
        assert (start, *clock) == (case["cycle_start"], case["days_left"], case["cycle_days"]), case
