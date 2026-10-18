// ABU-44: the app's pay-cycle clock must match the server's (shared/spend.py) for the same dates.
// tests/shared/test_monthly_pay_cycle_parity.py checks the same fixture on the server side.
import { describe, it, expect } from '@jest/globals';
import { cycleClock, nextPayday } from '../payCycle';

// `require` (not import) sidesteps a tsc JSON-path check across the src/ boundary.
const fixture = require('../../tests/fixtures/monthly_pay_cycle_parity.json') as {
  cases: { length: number; last_pay_date: string; today: string; next_payday: string; days_left: number; cycle_days: number }[];
};

describe('pay-cycle clock — parity with the server (ABU-44)', () => {
  it.each(fixture.cases)('$length-day code, payday $last_pay_date, today $today', (c) => {
    const [y, m, d] = c.today.split('-').map(Number);
    const today = new Date(y, m - 1, d);
    const payCycle = { length: c.length, last_pay_date: c.last_pay_date };
    expect(cycleClock(payCycle, today)).toEqual({ cycleLen: c.cycle_days, daysLeft: c.days_left });
    expect(nextPayday(payCycle, today)).toBe(c.next_payday);
  });
});
