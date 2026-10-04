// WHIT-126 follow-up — the shared local-date helpers (src/dateutil.ts) extracted from
// the pay-cycle picker + loan form. The whole reason they exist is to avoid UTC drift:
// an ISO date must parse/format on the LOCAL day, never shifted by a timezone. The
// runner pins TZ=Australia/Melbourne (UTC+10/+11), so a UTC parse would surface here.
import { describe, it, expect } from '@jest/globals';
import { parseISODate, toISODate, formatDayMonthYear, formatWeekdayShort, formatTimeOfDay } from '../dateutil';

describe('formatTimeOfDay (WHIT-713)', () => {
  const now = new Date(2026, 8, 18, 15, 0);

  it('reads a same-day time as a short local clock time', () => {
    expect(formatTimeOfDay(new Date(2026, 8, 18, 9, 40).getTime(), now)).toBe('9:40am');
    expect(formatTimeOfDay(new Date(2026, 8, 18, 12, 5).getTime(), now)).toBe('12:05pm');
    expect(formatTimeOfDay(new Date(2026, 8, 18, 0, 0).getTime(), now)).toBe('12:00am');
  });

  it('prefixes the day when the time is from an earlier day', () => {
    expect(formatTimeOfDay(new Date(2026, 8, 17, 21, 3).getTime(), now)).toBe('17 Sep, 9:03pm');
  });
});

describe('dateutil (WHIT-126)', () => {
  it('parses an ISO date to LOCAL midnight (no UTC drift)', () => {
    const d = parseISODate('2026-06-20');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(5);   // June
    expect(d.getDate()).toBe(20);   // the picked day, not the 19th
    expect(d.getHours()).toBe(0);   // local midnight
  });

  it('formats an ISO date as a local "D Mon YYYY" label', () => {
    expect(formatDayMonthYear('2026-06-20')).toBe('20 Jun 2026');
    expect(formatDayMonthYear('2027-01-01')).toBe('1 Jan 2027');   // low month edge, single-digit day
    expect(formatDayMonthYear('2026-12-25')).toBe('25 Dec 2026');  // high month edge (MONTHS[11])
  });

  it('round-trips a Date through toISODate and back on the same local day', () => {
    const iso = '2035-11-03';
    expect(toISODate(parseISODate(iso))).toBe(iso);
    // Zero-padding: single-digit month/day get a leading zero.
    expect(toISODate(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('formatWeekdayShort (WHIT-707)', () => {
  it('reads the local weekday of an ISO date', () => {
    expect(formatWeekdayShort('2026-10-09')).toBe('Fri');
    expect(formatWeekdayShort('2026-10-04')).toBe('Sun');
  });

  it('is empty for an unparseable date', () => {
    expect(formatWeekdayShort('')).toBe('');
  });
});

// WHIT-713 QA — the clock edges the planned cases skip.
describe('formatTimeOfDay edges', () => {
  const now = new Date(2026, 8, 18, 15, 0);

  it('[A13] noon is 12:00pm, a minute before midnight is 11:59pm, and 1am pads its minutes', () => {
    expect(formatTimeOfDay(new Date(2026, 8, 18, 12, 0).getTime(), now)).toBe('12:00pm');
    expect(formatTimeOfDay(new Date(2026, 8, 18, 11, 59).getTime(), now)).toBe('11:59am');
    expect(formatTimeOfDay(new Date(2026, 8, 18, 23, 59).getTime(), now)).toBe('11:59pm');
    expect(formatTimeOfDay(new Date(2026, 8, 18, 1, 5).getTime(), now)).toBe('1:05am');
  });

  it('[A14] the local-day boundary: 11:59pm yesterday gets the day, 12:00am today does not', () => {
    expect(formatTimeOfDay(new Date(2026, 8, 17, 23, 59).getTime(), now)).toBe('17 Sep, 11:59pm');
    expect(formatTimeOfDay(new Date(2026, 8, 18, 0, 0).getTime(), now)).toBe('12:00am');
  });

  it('[A15] reads the LOCAL day, not UTC: 9:40am Melbourne is still the previous UTC day', () => {
    // 2026-09-18 09:40 +10:00 = 2026-09-17 23:40Z. A UTC day check would wrongly prefix "17 Sep".
    expect(formatTimeOfDay(Date.parse('2026-09-18T09:40:00+10:00'), now)).toBe('9:40am');
  });

  it('[A16] across the DST switch (4 Oct 2026, Melbourne) the clock is local wall time', () => {
    const dstDay = new Date(2026, 9, 4, 12, 0);
    expect(formatTimeOfDay(Date.parse('2026-10-04T03:30:00+11:00'), dstDay)).toBe('3:30am');
    expect(formatTimeOfDay(Date.parse('2026-10-04T01:30:00+10:00'), dstDay)).toBe('1:30am');
  });
});
