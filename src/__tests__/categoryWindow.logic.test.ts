// WHIT-308: cycleWindow — the client twin of the server's current_cycle_window /
// nth_prior_cycle_window (shared/spend.py). Runs under TZ=Australia/Melbourne (see the test
// script) so the DEVICE-LOCAL date math is exercised in the user's real timezone.
import { describe, it, expect } from '@jest/globals';
import { cycleWindow } from '../context';

// A local-calendar Date at midnight for a Y-M-D (month 1-based here for clarity).
const day = (y: number, m: number, d: number) => new Date(y, m - 1, d);
const cycle = (length: number, last_pay_date: string) => ({ length, last_pay_date });

describe('cycleWindow', () => {
  it('current cycle: [most recent payday, today], both inclusive', () => {
    // 9 days into a fortnight → start stays on the payday, end is today.
    expect(cycleWindow(cycle(14, '2026-06-06'), 0, day(2026, 6, 15)))
      .toEqual({ start: '2026-06-06', end: '2026-06-15' });
  });

  it('current cycle rolls the start forward after a full length', () => {
    // 15 days in → one fortnight elapsed, start jumps to the next payday.
    expect(cycleWindow(cycle(14, '2026-06-06'), 0, day(2026, 6, 21)))
      .toEqual({ start: '2026-06-20', end: '2026-06-21' });
  });

  it('on payday the current window starts that day (a fresh cycle just began)', () => {
    expect(cycleWindow(cycle(14, '2026-06-06'), 0, day(2026, 6, 20)))
      .toEqual({ start: '2026-06-20', end: '2026-06-20' });
  });

  it.each([7, 14, 30])('respects the cycle length %d for the current window', (len) => {
    // one day in → start is the payday, end is today (a len-1 span).
    expect(cycleWindow(cycle(len, '2026-06-06'), 0, day(2026, 6, 7)))
      .toEqual({ start: '2026-06-06', end: '2026-06-07' });
  });

  it('nth prior cycle: a full length-day span abutting the current start, no overlap or gap', () => {
    // current start = 2026-06-06; 1st prior = [2026-05-23, 2026-06-05] (ends the day before).
    expect(cycleWindow(cycle(14, '2026-06-06'), 1, day(2026, 6, 15)))
      .toEqual({ start: '2026-05-23', end: '2026-06-05' });
    // 2nd prior steps back another fortnight, still abutting.
    expect(cycleWindow(cycle(14, '2026-06-06'), 2, day(2026, 6, 15)))
      .toEqual({ start: '2026-05-09', end: '2026-05-22' });
  });

  it('a future last_pay_date collapses the current window to [today, today]', () => {
    expect(cycleWindow(cycle(14, '2026-08-01'), 0, day(2026, 6, 15)))
      .toEqual({ start: '2026-06-15', end: '2026-06-15' });
  });

  // FAIL-ON-REVERT for the critic's MAJOR finding #1: the window must read the DEVICE-LOCAL
  // date, not UTC. At 08:00 Melbourne (AEST, UTC+10) on 15 Jun, the UTC instant is still 14 Jun
  // 22:00 — so a UTC-derived `end` would trail the local date by a day. Asserting the local date
  // fails any implementation that computes the bound off a UTC instant.
  it('uses the local calendar date, not UTC, for the window bounds', () => {
    // 08:00 on 15 Jun local. Under the suite's TZ (Australia/Melbourne, UTC+10) this instant is
    // still 14 Jun 22:00 in UTC, so a UTC-derived bound would read the PREVIOUS day. Asserting
    // the local date fails any implementation that computes `end` off a UTC instant.
    const localMorning = new Date(2026, 5, 15, 8, 0, 0);
    expect(cycleWindow(cycle(14, '2026-06-06'), 0, localMorning).end).toBe('2026-06-15');
  });

  it('counts whole days exactly across a Melbourne daylight-saving change', () => {
    // Melbourne springs forward Sun 2026-10-04. A window whose start-count spans it must still
    // land on the right calendar payday (14 whole days later), not drift by a day.
    expect(cycleWindow(cycle(14, '2026-09-27'), 0, day(2026, 10, 11)))
      .toEqual({ start: '2026-10-11', end: '2026-10-11' }); // exactly one fortnight later → payday
  });
});
