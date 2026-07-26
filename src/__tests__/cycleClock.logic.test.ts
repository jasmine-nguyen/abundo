// WHIT-9: the "days until next payday" clock. Runs under TZ=Australia/Melbourne
// (see the test script) so the daylight-saving-immunity is genuinely exercised.
import { describe, it, expect } from '@jest/globals';
import { cycleClock, cycleClockView } from '../context';

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
