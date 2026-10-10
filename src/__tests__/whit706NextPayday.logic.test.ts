// WHIT-706: the next payday date the Budgets top card shows, on the shared pay-cycle clock.
// Runs under TZ=Australia/Melbourne (the npm test script). The every-day-of-a-year sweep
// (nextPayday === today + daysLeft) lives in cycleClock.logic.test.ts.
import { describe, it, expect } from '@jest/globals';
import { nextPayday } from '../payCycle';

const day = (y: number, m: number, d: number) => new Date(y, m - 1, d);
const cycle = (length: number, last_pay_date: string) => ({ length, last_pay_date });

describe('nextPayday', () => {
  it('first payday more than one cycle ahead → still that first payday', () => {
    expect(nextPayday(cycle(14, '2026-07-31'), day(2026, 7, 1))).toBe('2026-07-31');
  });

  it('an unparseable date → empty string', () => {
    expect(nextPayday(cycle(14, 'not-a-date'), day(2026, 7, 1))).toBe('');
  });

  // The hero hides the line on '', never "NaN undefined".
  it('[A18] empty last_pay_date → empty string', () => {
    expect(nextPayday(cycle(14, ''), day(2026, 7, 1))).toBe('');
  });
});
