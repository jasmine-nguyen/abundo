// WHIT-706 QA: adversarial edges for nextPayday on the shared pay-cycle clock.
// Runs under TZ=Australia/Melbourne (the npm test script).
import { describe, it, expect } from '@jest/globals';
import { nextPayday, cycleClock, cycleStart } from '../payCycle';
import { toISODate, parseISODate } from '../dateutil';

const day = (y: number, m: number, d: number) => new Date(y, m - 1, d);
const cycle = (length: number, last_pay_date: string) => ({ length, last_pay_date });
const addDays = (iso: string, n: number) => {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + n);
  return toISODate(d);
};

describe('nextPayday (QA edges)', () => {
  // [A14] (P1) year rollover
  it('[A14] crosses a year boundary', () => {
    expect(nextPayday(cycle(14, '2026-12-20'), day(2027, 1, 1))).toBe('2027-01-03');
  });

  // [A15] (P1) the last day of a cycle → tomorrow is payday
  it('[A15] the day before payday → tomorrow', () => {
    expect(nextPayday(cycle(14, '2026-06-06'), day(2026, 6, 19))).toBe('2026-06-20');
  });

  // [A16] (P1) many cycles later, monthly length
  it('[A16] many cycles after the stored payday → still the end of the CURRENT cycle', () => {
    // 2026-01-01 + 30*9 = 2026-09-28 (cycle start); today 3 Oct → next 28 Oct
    expect(nextPayday(cycle(30, '2026-01-01'), day(2026, 10, 3))).toBe('2026-10-28');
  });

  // [A17] (P0) the next payday never drifts from the countdown or the cycle start (one clock),
  // across a full year including both Melbourne daylight-saving changes.
  it('[A17] nextPayday === today + daysLeft === cycleStart + length, every day of a year', () => {
    for (const length of [7, 14, 30]) {
      const pc = cycle(length, '2026-01-05');
      for (let i = 0; i < 366; i++) {
        const today = day(2026, 1, 5 + i);
        const todayIso = toISODate(today);
        const next = nextPayday(pc, today);
        expect(next).toBe(addDays(todayIso, cycleClock(pc, today).daysLeft));
        expect(next).toBe(addDays(cycleStart(pc, today), length));
        expect(next > todayIso).toBe(true);
      }
    }
  });

  // [A18] (P1) an empty last_pay_date → '' (the hero hides the line, never "NaN undefined")
  it('[A18] empty last_pay_date → empty string', () => {
    expect(nextPayday(cycle(14, ''), day(2026, 7, 1))).toBe('');
  });
});
