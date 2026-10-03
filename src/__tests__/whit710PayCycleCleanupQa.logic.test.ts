// WHIT-710 QA: nextPayday is now the only pay-date maths left, so it carries the old start-date
// and days-left-date guards on its own. Runs under TZ=Australia/Melbourne (the npm test script).
import { describe, it, expect } from '@jest/globals';
import { nextPayday, cycleClock } from '../payCycle';
import { isoToUtcDayMs, dateToUtcDayMs, utcDayMsToISO, MS_PER_DAY } from '../dateutil';

const cycle = (length: number, last_pay_date: string) => ({ length, last_pay_date });

describe('nextPayday (WHIT-710 QA)', () => {
  // [A1] (P0) one clock: at any time of day (just after midnight, late evening), every day of a
  // year with both daylight-saving changes, nextPayday === today + daysLeft and lands on a whole
  // cycle from the anchor. Replaces the deleted nextPaydayISO(daysLeft, today) composition.
  it('[A1] matches today + daysLeft at 00:01 and 23:59, every day of a year', () => {
    for (const length of [7, 14, 30]) {
      const pc = cycle(length, '2026-01-05');
      for (let i = 0; i < 366; i++) {
        for (const [h, m] of [[0, 1], [23, 59]]) {
          const today = new Date(2026, 0, 5 + i, h, m);
          const next = nextPayday(pc, today);
          const { daysLeft } = cycleClock(pc, today);
          expect(next).toBe(utcDayMsToISO(dateToUtcDayMs(today) + daysLeft * MS_PER_DAY));
          expect(((isoToUtcDayMs(next) - isoToUtcDayMs('2026-01-05')) / MS_PER_DAY) % length).toBe(0);
        }
      }
    }
  });

  // [A2] (P0) the day before payday → tomorrow; on payday → a full cycle on (the old
  // cycleStart "advances after each full cycle" boundary, len-1 / len / len+1 days in).
  it.each([7, 14, 30])('[A2] rolls over exactly on payday (length %d)', (length) => {
    const pc = cycle(length, '2026-06-06');
    const base = Date.UTC(2026, 5, 6);
    const local = (offset: number) => {
      const d = new Date(base + offset * MS_PER_DAY);
      return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12);
    };
    const iso = (offset: number) => utcDayMsToISO(base + offset * MS_PER_DAY);
    expect(nextPayday(pc, local(length - 1))).toBe(iso(length));
    expect(nextPayday(pc, local(length))).toBe(iso(2 * length));
    expect(nextPayday(pc, local(length + 1))).toBe(iso(2 * length));
  });

  // [A3] (P1) on the 25-hour daylight-saving-end day itself (5 Apr 2026), a payday counts as
  // payday from just after midnight to late evening → a full cycle on, not the same day.
  it('[A3] a payday that falls on the DST-end day, early and late', () => {
    expect(nextPayday(cycle(14, '2026-03-22'), new Date(2026, 3, 5, 0, 30))).toBe('2026-04-19');
    expect(nextPayday(cycle(14, '2026-03-22'), new Date(2026, 3, 5, 23, 30))).toBe('2026-04-19');
  });
});
