// WHIT-630 QA: plain value tests on the pay-cycle clock in its new home, src/payCycle.ts.
// Runs under TZ=Australia/Melbourne (the npm test script), so the daylight-saving cases are real.
import { describe, it, expect } from '@jest/globals';
import { cycleName, cycleClock, cycleStart, cycleClockView, elapsedFrac, nextPaydayISO } from '../payCycle';

const day = (y: number, m: number, d: number) => new Date(y, m - 1, d);
const cycle = (length: number, last_pay_date: string) => ({ length, last_pay_date });

describe('cycleName', () => {
  it('[A13] (P1) names 7, 14 and anything else', () => {
    expect(cycleName(7)).toBe('Weekly');
    expect(cycleName(14)).toBe('Fortnightly');
    expect(cycleName(30)).toBe('Monthly');
    expect(cycleName(28)).toBe('Monthly');
  });
});

describe('cycleClock', () => {
  it('[A14] (P0) payday reads the full length', () => {
    expect(cycleClock(cycle(14, '2026-06-06'), day(2026, 6, 6))).toEqual({ cycleLen: 14, daysLeft: 14 });
  });

  it('[A14] (P0) mid-cycle counts down', () => {
    expect(cycleClock(cycle(14, '2026-06-06'), day(2026, 6, 13)).daysLeft).toBe(7);
  });

  it('[A14] (P0) the last day before payday reads 1', () => {
    expect(cycleClock(cycle(7, '2026-06-06'), day(2026, 6, 12)).daysLeft).toBe(1);
  });

  it('[A15] (P1) before the first payday the clock is clamped to the full length', () => {
    expect(cycleClock(cycle(14, '2026-07-10'), day(2026, 7, 1)).daysLeft).toBe(14);
  });

  it('[A16] (P1) crossing the Melbourne daylight-saving start (4 Oct 2026) does not shift a day', () => {
    expect(cycleClock(cycle(14, '2026-09-28'), day(2026, 10, 5)).daysLeft).toBe(7);
  });

  it('[A16] (P1) crossing the Melbourne daylight-saving end (5 Apr 2026) does not shift a day', () => {
    expect(cycleClock(cycle(14, '2026-03-30'), day(2026, 4, 6)).daysLeft).toBe(7);
  });
});

describe('cycleStart', () => {
  it('[A17] (P1) is the most recent payday on or before today', () => {
    expect(cycleStart(cycle(14, '2026-06-06'), day(2026, 6, 25))).toBe('2026-06-20');
    expect(cycleStart(cycle(14, '2026-06-06'), day(2026, 6, 6))).toBe('2026-06-06');
  });

  it('[A17] (P1) is empty for a future first payday', () => {
    expect(cycleStart(cycle(14, '2026-07-10'), day(2026, 7, 1))).toBe('');
  });

  it('[A17] (P1) is empty for an unparseable date', () => {
    expect(cycleStart(cycle(14, 'not-a-date'), day(2026, 7, 1))).toBe('');
  });
});

describe('cycleClockView', () => {
  it('[A18] (P0) prefers the server days_left over the client clock', () => {
    expect(cycleClockView({ length: 14, last_pay_date: '1999-01-01', days_left: 3 })).toEqual({ cycleLen: 14, daysLeft: 3 });
  });

  it('[A18] (P0) keeps a server 0', () => {
    expect(cycleClockView({ length: 14, last_pay_date: '1999-01-01', days_left: 0 }).daysLeft).toBe(0);
  });

  it('[A18] (P1) clamps a corrupt server value into [0, length]', () => {
    expect(cycleClockView({ length: 14, last_pay_date: '1999-01-01', days_left: -3 }).daysLeft).toBe(0);
    expect(cycleClockView({ length: 14, last_pay_date: '1999-01-01', days_left: 40 }).daysLeft).toBe(14);
  });
});

describe('elapsedFrac', () => {
  it('[A19] (P1) runs from 0 on payday to 1 on the last day', () => {
    expect(elapsedFrac({ cycleLen: 14, daysLeft: 14 })).toBe(0);
    expect(elapsedFrac({ cycleLen: 14, daysLeft: 7 })).toBe(0.5);
    expect(elapsedFrac({ cycleLen: 14, daysLeft: 0 })).toBe(1);
  });
});

describe('nextPaydayISO (WHIT-707)', () => {
  it('adds the days left to today', () => {
    expect(nextPaydayISO(6, day(2026, 10, 3))).toBe('2026-10-09');
    expect(nextPaydayISO(0, day(2026, 10, 3))).toBe('2026-10-03');
  });

  it('crosses a month end, a daylight-saving change and a year end', () => {
    expect(nextPaydayISO(14, day(2026, 9, 25))).toBe('2026-10-09');
    expect(nextPaydayISO(30, day(2026, 12, 15))).toBe('2027-01-14');
  });
});
