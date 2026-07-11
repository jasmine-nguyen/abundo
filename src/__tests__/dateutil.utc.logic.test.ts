// WHIT-253: the shared UTC whole-day helpers behind cycleClock / paydaysUntil /
// milestoneTime. Runs under TZ=Australia/Melbourne (see the test script) so the
// local-vs-UTC component reads and the daylight-saving-immunity are genuinely
// exercised — Melbourne is UTC+10/+11, so a local midnight is the *previous* day
// in UTC, which is exactly what would break a getUTC* slip.
import { describe, it, expect } from '@jest/globals';
import { isoToUtcDayMs, dateToUtcDayMs, wholeDaysBetween } from '../dateutil';

describe('isoToUtcDayMs', () => {
  it('parses an ISO date to its UTC-midnight timestamp', () => {
    expect(isoToUtcDayMs('2026-06-06')).toBe(Date.UTC(2026, 5, 6));
  });

  it('is NaN on an unparseable date (callers decide what that means)', () => {
    expect(Number.isNaN(isoToUtcDayMs('not-a-date'))).toBe(true);
  });
});

describe('dateToUtcDayMs', () => {
  it('reads the LOCAL calendar day, not the UTC one', () => {
    // new Date(2026, 5, 6) is local midnight 6 Jun; under Melbourne TZ that instant
    // is 5 Jun in UTC. Reading local components must still yield 6 Jun — this fails
    // if the helper ever slips to getUTCFullYear/getUTCMonth/getUTCDate.
    expect(dateToUtcDayMs(new Date(2026, 5, 6))).toBe(Date.UTC(2026, 5, 6));
  });

  it('ignores the wall-clock time within the local day', () => {
    expect(dateToUtcDayMs(new Date(2026, 5, 6, 23, 59, 59))).toBe(Date.UTC(2026, 5, 6));
  });
});

describe('wholeDaysBetween', () => {
  it('counts integer-exact whole days forward', () => {
    expect(wholeDaysBetween(isoToUtcDayMs('2026-06-06'), isoToUtcDayMs('2026-06-20'))).toBe(14);
  });

  it('is negative when `to` is before `from`', () => {
    expect(wholeDaysBetween(isoToUtcDayMs('2026-06-20'), isoToUtcDayMs('2026-06-06'))).toBe(-14);
  });

  it('counts exactly across a Melbourne daylight-saving change', () => {
    // Melbourne springs forward on Sun 2026-10-04. A device local day of 11 Oct,
    // 14 days after a 27 Sep payday, must still be exactly 14 whole days — not 13/15.
    expect(wholeDaysBetween(isoToUtcDayMs('2026-09-27'), dateToUtcDayMs(new Date(2026, 9, 11)))).toBe(14);
  });

  it('is NaN when either endpoint is NaN', () => {
    expect(Number.isNaN(wholeDaysBetween(NaN, isoToUtcDayMs('2026-06-06')))).toBe(true);
    expect(Number.isNaN(wholeDaysBetween(isoToUtcDayMs('2026-06-06'), NaN))).toBe(true);
  });
});
