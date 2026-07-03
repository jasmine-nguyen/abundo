// WHIT-9: the "days until next payday" clock. Runs under TZ=Australia/Melbourne
// (see the test script) so the daylight-saving-immunity is genuinely exercised.
import { describe, it, expect } from '@jest/globals';
import { cycleClock } from '../context';

// Build a local-calendar Date for a given Y-M-D (month is 1-based here for clarity).
const day = (y: number, m: number, d: number) => new Date(y, m - 1, d);

describe('cycleClock', () => {
  const cycle = (length: number, last_pay_date: string) => ({ length, last_pay_date });

  it('reads full length on payday itself (a fresh cycle just began)', () => {
    expect(cycleClock(cycle(14, '2026-06-06'), day(2026, 6, 6))).toEqual({ cycleLen: 14, daysLeft: 14 });
  });

  it('counts down one day at a time', () => {
    expect(cycleClock(cycle(14, '2026-06-06'), day(2026, 6, 7)).daysLeft).toBe(13);
    expect(cycleClock(cycle(14, '2026-06-06'), day(2026, 6, 13)).daysLeft).toBe(7);
    expect(cycleClock(cycle(14, '2026-06-06'), day(2026, 6, 19)).daysLeft).toBe(1);
  });

  it('rolls over to a fresh full cycle after exactly `length` days', () => {
    expect(cycleClock(cycle(14, '2026-06-06'), day(2026, 6, 20)).daysLeft).toBe(14);
  });

  it('rolls over across many elapsed cycles, not just the first', () => {
    // 3 full fortnights later → payday again → full.
    expect(cycleClock(cycle(14, '2026-06-06'), day(2026, 7, 18)).daysLeft).toBe(14);
    // one day into the 4th cycle.
    expect(cycleClock(cycle(14, '2026-06-06'), day(2026, 7, 19)).daysLeft).toBe(13);
  });

  it('clamps to full length before the first payday (never negative-into-cycle)', () => {
    expect(cycleClock(cycle(14, '2026-06-06'), day(2026, 6, 5)).daysLeft).toBe(14);
  });

  it.each([7, 14, 30])('respects the cycle length %d', (len) => {
    expect(cycleClock(cycle(len, '2026-06-06'), day(2026, 6, 6)).cycleLen).toBe(len);
    // one day in → length-1 remaining
    expect(cycleClock(cycle(len, '2026-06-06'), day(2026, 6, 7)).daysLeft).toBe(len - 1);
  });

  it('counts whole calendar days exactly across a Melbourne daylight-saving change', () => {
    // Melbourne springs forward on Sun 2026-10-04 (02:00 → 03:00). A cycle that
    // straddles it must still count 14 whole days, not 13 or 15.
    expect(cycleClock(cycle(14, '2026-09-27'), day(2026, 10, 11)).daysLeft).toBe(14); // exactly 14 days later
    expect(cycleClock(cycle(14, '2026-09-27'), day(2026, 10, 4)).daysLeft).toBe(7);   // 7 days in, spans the change
  });
});
