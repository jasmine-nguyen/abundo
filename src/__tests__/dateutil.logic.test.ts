// WHIT-126 follow-up — the shared local-date helpers (src/dateutil.ts) extracted from
// the pay-cycle picker + loan form. The whole reason they exist is to avoid UTC drift:
// an ISO date must parse/format on the LOCAL day, never shifted by a timezone. The
// runner pins TZ=Australia/Melbourne (UTC+10/+11), so a UTC parse would surface here.
import { describe, it, expect } from '@jest/globals';
import { parseISODate, toISODate, formatDayMonthYear } from '../dateutil';

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
