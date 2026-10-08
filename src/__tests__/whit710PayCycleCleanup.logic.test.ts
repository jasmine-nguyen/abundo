// WHIT-710: nextPayday carries the pay-date checks that used to run through the old start-date
// and days-left date helpers.
// Runs under TZ=Australia/Melbourne (the npm test script).
import { describe, it, expect } from '@jest/globals';
import { nextPayday } from '../payCycle';
import { DEFAULT_PAY_CYCLE } from '../queries';
import { isoToUtcDayMs, dateToUtcDayMs, formatDayMonth, MS_PER_DAY } from '../dateutil';

const day = (y: number, m: number, d: number) => new Date(y, m - 1, d);
const cycle = (length: number, last_pay_date: string) => ({ length, last_pay_date });

describe('nextPayday carries the moved pay-date checks', () => {
  it('advances by a full cycle after each payday', () => {
    expect(nextPayday(cycle(14, '2026-06-06'), day(2026, 6, 20))).toBe('2026-07-04');
    expect(nextPayday(cycle(14, '2026-06-06'), day(2026, 7, 19))).toBe('2026-08-01');
  });

  it('ignores the wall-clock time of day', () => {
    expect(nextPayday(cycle(14, '2026-06-06'), new Date(2026, 5, 19, 23, 59, 59))).toBe('2026-06-20');
  });

  it('the default seed cycle gives a future date a whole number of cycles from its anchor', () => {
    const today = day(2026, 9, 18);
    const next = nextPayday(DEFAULT_PAY_CYCLE, today);
    expect(next).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const days = (isoToUtcDayMs(next) - isoToUtcDayMs(DEFAULT_PAY_CYCLE.last_pay_date)) / MS_PER_DAY;
    expect(Number.isInteger(days)).toBe(true);
    expect(days % DEFAULT_PAY_CYCLE.length).toBe(0);
    expect(isoToUtcDayMs(next)).toBeGreaterThan(dateToUtcDayMs(today));
  });

  it('crosses the year end', () => {
    const next = nextPayday(cycle(30, '2025-12-08'), day(2025, 12, 20));
    expect(next).toBe('2026-01-07');
    expect(formatDayMonth(next)).toBe('7 Jan');
    expect(nextPayday(cycle(30, '2026-12-15'), day(2026, 12, 15))).toBe('2027-01-14');
  });

  it('crosses a month end and the daylight-saving start', () => {
    expect(nextPayday(cycle(14, '2026-09-25'), day(2026, 9, 25))).toBe('2026-10-09');
  });

  it('matches the countdown: today + daysLeft', () => {
    expect(nextPayday(cycle(14, '2026-09-27'), day(2026, 10, 3))).toBe('2026-10-11');
  });

  it('late evening before the daylight-saving start stays on the right day', () => {
    expect(nextPayday(cycle(14, '2026-09-20'), new Date(2026, 9, 3, 23, 30))).toBe('2026-10-04');
    expect(nextPayday(cycle(14, '2026-09-20'), new Date(2026, 9, 4, 0, 15))).toBe('2026-10-18');
  });

  it('late evening across the daylight-saving end stays on the right day', () => {
    expect(nextPayday(cycle(14, '2026-03-22'), new Date(2026, 3, 4, 23, 59))).toBe('2026-04-05');
  });
});
