// WHIT-9: the "days until next payday" clock. Runs under TZ=Australia/Melbourne
// (see the test script) so the daylight-saving-immunity is genuinely exercised.
import { describe, it, expect } from '@jest/globals';
import { cycleClock, cycleClockView, cycleStart } from '../context';

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

  it('propagates NaN daysLeft for an unparseable last_pay_date (no silent 0)', () => {
    // A bad date makes pay NaN → daysLeft stays NaN rather than reading as a real countdown. Locks
    // cycleClock's half of the shared-anchor refactor (WHIT-575); cycleStart's NaN case is below.
    expect(Number.isNaN(cycleClock(cycle(14, 'not-a-date'), day(2026, 6, 6)).daysLeft)).toBe(true);
  });

  it('ignores the wall-clock time on `today` — a fractional Date reads the same whole-day countdown', () => {
    // dateToUtcDayMs keeps only local Y-M-D, so 23:59 must equal midnight — else a real "now" (always
    // carries a time) would drift the countdown. Fail-on-revert: leak the time and this shifts.
    expect(cycleClock(cycle(14, '2026-06-06'), new Date(2026, 5, 13, 23, 59, 59)).daysLeft).toBe(7);
    expect(cycleClock(cycle(14, '2026-06-06'), new Date(2026, 5, 13, 0, 0, 0)).daysLeft).toBe(7);
  });

  it('propagates NaN daysLeft for an EMPTY last_pay_date (missing data, distinct from a garbage string)', () => {
    expect(Number.isNaN(cycleClock(cycle(14, ''), day(2026, 6, 6)).daysLeft)).toBe(true);
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

// WHIT-574: the current cycle's START date (its payday), anchored on last_pay_date and advanced by
// whole cycle lengths on the same UTC-whole-day clock as cycleClock — so "Started X" and the
// "N days left" countdown always agree in the normal case (start + daysLeft counts to the next payday).
describe('cycleStart', () => {
  const cycle = (length: number, last_pay_date: string) => ({ length, last_pay_date });

  it('is the payday itself on payday (a fresh cycle just began)', () => {
    expect(cycleStart(cycle(14, '2026-06-06'), day(2026, 6, 6))).toBe('2026-06-06');
  });

  it('stays the same payday through the cycle', () => {
    expect(cycleStart(cycle(14, '2026-06-06'), day(2026, 6, 7))).toBe('2026-06-06');
    expect(cycleStart(cycle(14, '2026-06-06'), day(2026, 6, 19))).toBe('2026-06-06');
  });

  it('advances to the current window’s payday after each full cycle (not the original)', () => {
    expect(cycleStart(cycle(14, '2026-06-06'), day(2026, 6, 20))).toBe('2026-06-20'); // fresh cycle
    expect(cycleStart(cycle(14, '2026-06-06'), day(2026, 7, 18))).toBe('2026-07-18'); // 3 fortnights on
    expect(cycleStart(cycle(14, '2026-06-06'), day(2026, 7, 19))).toBe('2026-07-18'); // one day into the 4th
  });

  it('hides the line before the first payday (a future last_pay_date → empty)', () => {
    // The cycle hasn't started yet — "Started today" would be a false statement, so cycleStart
    // returns '' and the hero omits the line. Fail-on-revert: drop the `pay > todayMs` guard and
    // this returns a bogus past date instead.
    expect(cycleStart(cycle(14, '2026-06-06'), day(2026, 6, 5))).toBe('');
    expect(cycleStart(cycle(30, '2026-06-06'), day(2026, 6, 1))).toBe('');
  });

  it.each([7, 14, 30])('anchors on the payday for length %d', (len) => {
    expect(cycleStart(cycle(len, '2026-06-06'), day(2026, 6, 6))).toBe('2026-06-06');
    expect(cycleStart(cycle(len, '2026-06-06'), day(2026, 6, 7))).toBe('2026-06-06');
  });

  it('lands on the exact payday across a Melbourne daylight-saving change (no day drift)', () => {
    // Monthly (30d), today is 14 days in, spanning the 2026-10-04 spring-forward.
    expect(cycleStart(cycle(30, '2026-09-27'), day(2026, 10, 11))).toBe('2026-09-27');
  });

  it('is empty for an unparseable last_pay_date (the caller hides the line)', () => {
    expect(cycleStart(cycle(14, 'not-a-date'), day(2026, 6, 6))).toBe('');
  });

  it('ignores the wall-clock time on `today` — 23:59 lands on the same payday as midnight', () => {
    expect(cycleStart(cycle(14, '2026-06-06'), new Date(2026, 5, 19, 23, 59, 59))).toBe('2026-06-06');
  });

  it('is empty for an EMPTY last_pay_date (missing data → hide the line, same as unparseable)', () => {
    expect(cycleStart(cycle(14, ''), day(2026, 6, 6))).toBe('');
  });
});
