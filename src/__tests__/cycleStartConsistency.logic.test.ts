// WHIT-574 — adversarial gaps for the Budgets "Started {date}" hero line, beyond the cycleStart
// unit cases in cycleClock.logic.test.ts. Covers the countdown/anchor composition invariant
// [A-inv], the DEFAULT_PAY_CYCLE fallback [A-default], year-boundary formatting [A-year], and
// started-exactly-today [A-today]. Runs under TZ=Australia/Melbourne (see the test script).
import { describe, it, expect } from '@jest/globals';
import { cycleStart, cycleClock } from '../context';
import { DEFAULT_PAY_CYCLE } from '../queries';
import { isoToUtcDayMs, dateToUtcDayMs, formatDayMonth, MS_PER_DAY } from '../dateutil';

const day = (y: number, m: number, d: number) => new Date(y, m - 1, d);
const cycle = (length: number, last_pay_date: string) => ({ length, last_pay_date });

describe('cycleStart <-> cycleClock composition [A-inv]', () => {
  // The hero shows "Started {cycleStart}" ABOVE "{daysLeft} days left". They must compose: the shown
  // start + one whole cycle == today + daysLeft (== the next payday). If the anchor advance in
  // cycleStart is wrong, the start no longer lands one cycle before the countdown's target.
  // Fail-on-revert: drop `cyclesElapsed * length` from cycleStart and the mid-cycle offsets break.
  it.each([7, 14, 30])('start + length === today + daysLeft on the same today (length %d)', (len) => {
    const pc = cycle(len, '2026-06-06');
    for (const off of [0, 1, 5, len - 1, len, len + 1, 3 * len + 2]) {
      const iso = new Date(Date.UTC(2026, 5, 6) + off * MS_PER_DAY).toISOString().slice(0, 10);
      const [Y, M, D] = iso.split('-').map(Number);
      const today = day(Y, M, D);
      const start = cycleStart(pc, today);
      const { daysLeft } = cycleClock(pc, today);
      expect(isoToUtcDayMs(start) + len * MS_PER_DAY).toBe(dateToUtcDayMs(today) + daysLeft * MS_PER_DAY);
    }
  });
});

describe('DEFAULT_PAY_CYCLE fallback produces a sane date [A-default]', () => {
  // When the pay-cycle read has no cache the hero renders cycleStart(DEFAULT_PAY_CYCLE). Guard the
  // ACTUAL seed (imported, not copied): a real, non-empty past payday — never '' (which would hide
  // the line) and never a future date. Fails if the seed is ever changed to a future last_pay_date.
  it('the real default seed yields a non-empty payday on-or-before today', () => {
    const today = day(2026, 9, 18);
    const start = cycleStart(DEFAULT_PAY_CYCLE, today);
    expect(start).not.toBe('');
    expect(start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const daysFromAnchor = (isoToUtcDayMs(start) - isoToUtcDayMs(DEFAULT_PAY_CYCLE.last_pay_date)) / MS_PER_DAY;
    expect(daysFromAnchor % DEFAULT_PAY_CYCLE.length).toBe(0);   // a whole number of cycles from the anchor
    expect(isoToUtcDayMs(start)).toBeLessThanOrEqual(dateToUtcDayMs(today)); // never in the future
  });
});

describe('year-boundary formatting drops the year [A-year]', () => {
  // A 30-day cycle that started in December, viewed in January, shows "8 Dec" with NO year — the
  // approved compact format. Pinned so a future "add the year back" is a conscious call, not a silent one.
  it('a Dec start viewed in Jan renders "8 Dec" (no 2025)', () => {
    const start = cycleStart(cycle(30, '2025-12-08'), day(2026, 1, 3));
    expect(start).toBe('2025-12-08');
    expect(formatDayMonth(start)).toBe('8 Dec');
    expect(formatDayMonth(start)).not.toMatch(/2025|2026/);
  });
});

describe('started exactly today [A-today]', () => {
  // On payday cycleStart === today; the hero then reads "Started {today}" with a full countdown.
  it('is today, formatted without a leading zero', () => {
    expect(cycleStart(cycle(14, '2026-06-01'), day(2026, 6, 1))).toBe('2026-06-01');
    expect(formatDayMonth('2026-06-01')).toBe('1 Jun'); // "1 Jun", never "01 Jun"
  });
});
