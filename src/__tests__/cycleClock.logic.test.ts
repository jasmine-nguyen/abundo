// WHIT-9: the "days until next payday" clock. Runs under TZ=Australia/Melbourne
// (see the test script) so the daylight-saving-immunity is genuinely exercised.
import { describe, it, expect } from '@jest/globals';
import { cycleClock, cycleClockView, cycleName, dayOfCycle, nextPayday } from '../payCycle';
import { isoToUtcDayMs, dateToUtcDayMs, utcDayMsToISO, MS_PER_DAY } from '../dateutil';

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

  it('counts whole calendar days exactly across a Melbourne daylight-saving change', () => {
    // Melbourne springs forward on Sun 2026-10-04 (02:00 → 03:00). A cycle that
    // straddles it must still count 14 whole days, not 13 or 15.
    expect(cycleClock(cycle(14, '2026-09-27'), day(2026, 10, 11)).daysLeft).toBe(14); // exactly 14 days later
    expect(cycleClock(cycle(14, '2026-09-27'), day(2026, 10, 4)).daysLeft).toBe(7);   // 7 days in, spans the change
  });

  it('[A16] (P1) crossing the Melbourne daylight-saving end (5 Apr 2026) does not shift a day', () => {
    expect(cycleClock(cycle(14, '2026-03-30'), day(2026, 4, 6)).daysLeft).toBe(7);
  });

  it('propagates NaN daysLeft for an unparseable last_pay_date (no silent 0)', () => {
    // A bad date makes pay NaN → daysLeft stays NaN rather than reading as a real countdown. Locks
    // cycleClock's half of the shared-anchor refactor (WHIT-575); nextPayday's NaN case is in
    // whit706NextPayday.logic.test.ts.
    expect(Number.isNaN(cycleClock(cycle(14, 'not-a-date'), day(2026, 6, 6)).daysLeft)).toBe(true);
  });

  it('ignores the wall-clock time on `today` — a fractional Date reads the same whole-day countdown', () => {
    // dateToUtcDayMs keeps only local Y-M-D, so 23:59 must equal midnight — else a real "now" (always
    // carries a time) would drift the countdown. Fail-on-revert: leak the time and this shifts.
    expect(cycleClock(cycle(14, '2026-06-06'), new Date(2026, 5, 13, 23, 59, 59)).daysLeft).toBe(7);
    expect(cycleClock(cycle(14, '2026-06-06'), new Date(2026, 5, 13, 0, 0, 0)).daysLeft).toBe(7);
  });
});

describe('cycleName', () => {
  it('[A13] (P1) names 7, 14 and anything else', () => {
    expect(cycleName(7)).toBe('Weekly');
    expect(cycleName(14)).toBe('Fortnightly');
    expect(cycleName(30)).toBe('Monthly');
    expect(cycleName(28)).toBe('Monthly');
  });
});

describe('nextPayday', () => {
  // One clock: at any time of day, every day of a year with both daylight-saving changes,
  // nextPayday === today + daysLeft and lands on a payday: a whole cycle from the anchor, or for
  // monthly (ABU-44) the anchor's day of the month.
  it('[A1] matches today + daysLeft at 00:01 and 23:59, every day of a year', () => {
    for (const length of [7, 14, 30]) {
      const pc = { length, last_pay_date: '2026-01-05' };
      for (let i = 0; i < 366; i++) {
        for (const [h, m] of [[0, 1], [23, 59]]) {
          const today = new Date(2026, 0, 5 + i, h, m);
          const next = nextPayday(pc, today);
          const { daysLeft } = cycleClock(pc, today);
          expect(next).toBe(utcDayMsToISO(dateToUtcDayMs(today) + daysLeft * MS_PER_DAY));
          if (length === 30) expect(next.slice(8)).toBe('05');
          else expect(((isoToUtcDayMs(next) - isoToUtcDayMs('2026-01-05')) / MS_PER_DAY) % length).toBe(0);
        }
      }
    }
  });
});

// WHIT-341: the screens read cycleClockView, which prefers the server's authoritative
// days_left (one clock, no UTC/Melbourne drift) and falls back to cycleClock when absent.
describe('cycleClockView', () => {
  it('prefers the server days_left when present (regardless of the local clock)', () => {
    // A deliberately "wrong" local clock would give a different daysLeft; the server value wins.
    const view = cycleClockView({ length: 14, last_pay_date: '2026-06-06', days_left: 9 });
    expect(view).toEqual({ cycleLen: 14, daysLeft: 9 });
  });

  it('falls back to the client cycleClock when days_left is absent (older server / cold cache)', () => {
    // No days_left → same result the raw cycleClock gives for "today". cycleLen always = length.
    const payCycle = { length: 14, last_pay_date: '2026-06-06' };
    expect(cycleClockView(payCycle)).toEqual({ cycleLen: 14, daysLeft: cycleClock(payCycle).daysLeft });
  });

  it('prefers the server cycle_days for the cycle length (ABU-44)', () => {
    expect(cycleClockView({ length: 30, last_pay_date: '2026-01-15', days_left: 23, cycle_days: 28 }))
      .toEqual({ cycleLen: 28, daysLeft: 23 });
  });

  it('takes days_left === 0 from the server (not the fallback)', () => {
    // 0 is a real value, not "absent" — the ?? must not treat it as missing.
    expect(cycleClockView({ length: 30, last_pay_date: '2026-06-06', days_left: 0 }).daysLeft).toBe(0);
  });

  it('clamps a server days_left outside [0, length] (keeps the progress bar in range)', () => {
    // A corrupt/older-cache value can't drive elapsedFrac out of [0,1] → no negative bars.
    expect(cycleClockView({ length: 14, last_pay_date: '2026-06-06', days_left: 21 }).daysLeft).toBe(14);
    expect(cycleClockView({ length: 14, last_pay_date: '2026-06-06', days_left: -3 }).daysLeft).toBe(0);
  });
});

describe('dayOfCycle', () => {
  it.each([
    ['payday (all days left) is day 1', 14, 14, 1],
    ['mid-cycle is length − daysLeft + 1', 14, 9, 6],
    ['the last day before payday (1 left) is the final day', 14, 1, 14],
    ['an out-of-range 0 left is capped at the final day', 14, 0, 14],
  ])('%s', (_label, cycleLen, daysLeft, day) => {
    expect(dayOfCycle({ cycleLen, daysLeft })).toBe(day);
  });
});

describe('monthly pay cycle steps by calendar month (ABU-44)', () => {
  const monthly = (last_pay_date: string) => ({ length: 30, last_pay_date });

  it.each([
    [day(2026, 2, 20), '2026-03-15'],
    [day(2026, 6, 15), '2026-07-15'],
    [day(2026, 10, 14), '2026-10-15'],
  ])('a 15th payday keeps landing on the 15th (today %p → %s)', (today, expected) => {
    expect(nextPayday(monthly('2026-01-15'), today)).toBe(expected);
  });

  it.each([
    [day(2026, 2, 1), '2026-02-28'],
    [day(2026, 3, 1), '2026-03-31'],
    [day(2026, 4, 1), '2026-04-30'],
  ])('a 31st payday uses the month\'s last day (today %p → %s)', (today, expected) => {
    expect(nextPayday(monthly('2026-01-31'), today)).toBe(expected);
  });

  it('the cycle length is the real month length: Feb 15 → Mar 15 is 28 days', () => {
    expect(cycleClock(monthly('2026-01-15'), day(2026, 2, 20))).toEqual({ cycleLen: 28, daysLeft: 23 });
  });

  it('a 31-day month is a 31-day cycle', () => {
    expect(cycleClock(monthly('2026-01-15'), day(2026, 7, 15))).toEqual({ cycleLen: 31, daysLeft: 31 });
  });

  it('before the first payday: the days left are held to the first cycle and the next payday is it', () => {
    const payCycle = monthly('2026-03-31');
    expect(cycleClock(payCycle, day(2026, 1, 10))).toEqual({ cycleLen: 30, daysLeft: 30 });
    expect(nextPayday(payCycle, day(2026, 1, 10))).toBe('2026-03-31');
  });
});
