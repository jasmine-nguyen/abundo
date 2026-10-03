// WHIT-706: the next payday date the Budgets top card shows, on the shared pay-cycle clock.
// Runs under TZ=Australia/Melbourne (the npm test script).
import { describe, it, expect } from '@jest/globals';
import { nextPayday } from '../payCycle';

const day = (y: number, m: number, d: number) => new Date(y, m - 1, d);
const cycle = (length: number, last_pay_date: string) => ({ length, last_pay_date });

describe('nextPayday', () => {
  it('mid-cycle → the payday that ends the current cycle', () => {
    // cycle started 20 Jun (6 Jun + 14) → next payday 4 Jul
    expect(nextPayday(cycle(14, '2026-06-06'), day(2026, 6, 25))).toBe('2026-07-04');
  });

  it('on payday → a full cycle ahead (a fresh cycle just began)', () => {
    expect(nextPayday(cycle(14, '2026-06-06'), day(2026, 6, 6))).toBe('2026-06-20');
  });

  it('first payday still ahead → that first payday', () => {
    expect(nextPayday(cycle(14, '2026-07-10'), day(2026, 7, 1))).toBe('2026-07-10');
  });

  it('first payday more than one cycle ahead → still that first payday', () => {
    expect(nextPayday(cycle(14, '2026-07-31'), day(2026, 7, 1))).toBe('2026-07-31');
  });

  it('crossing the Melbourne daylight-saving start does not shift the date', () => {
    expect(nextPayday(cycle(14, '2026-09-28'), day(2026, 10, 5))).toBe('2026-10-12');
  });

  it('an unparseable date → empty string', () => {
    expect(nextPayday(cycle(14, 'not-a-date'), day(2026, 7, 1))).toBe('');
  });
});
