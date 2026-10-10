// WHIT-126 follow-up — the shared local-date helpers (src/dateutil.ts) extracted from
// the pay-cycle picker + loan form. The whole reason they exist is to avoid UTC drift:
// an ISO date must parse/format on the LOCAL day, never shifted by a timezone. The
// runner pins TZ=Australia/Melbourne (UTC+10/+11), so a UTC parse would surface here.
import { describe, it, expect } from '@jest/globals';
import {
  parseISODate, toISODate, formatDayMonthYear, formatWeekdayShort, formatTimeOfDay, pendingLabel,
  isoToUtcDayMs, dateToUtcDayMs, wholeDaysBetween, utcDayMsToISO, formatDayMonth, formatDateRange, formatMonthYear,
} from '../dateutil';
import { paydaysUntil, milestoneView } from '../context';
import { cycleClock } from '../payCycle';
import { MILESTONES } from '../milestones';
import { makeState } from './factory';

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

  it('[A15] reads the LOCAL day, not UTC: 9:40am Melbourne is still the previous UTC day', () => {
    // 2026-09-18 09:40 +10:00 = 2026-09-17 23:40Z. A UTC day check would wrongly prefix "17 Sep".
    expect(formatTimeOfDay(Date.parse('2026-09-18T09:40:00+10:00'), now)).toBe('9:40am');
    // The local-day boundary: 11:59pm yesterday gets the day, 12:00am today does not.
    expect(formatTimeOfDay(new Date(2026, 8, 17, 23, 59).getTime(), now)).toBe('17 Sep, 11:59pm');
    expect(formatTimeOfDay(new Date(2026, 8, 18, 0, 0).getTime(), now)).toBe('12:00am');
  });
});

// WHIT-844 — the edges the row's 0/3/4/7-day table (TransactionRow.screen.test.tsx) skips.
describe('pendingLabel edges', () => {
  it.each([
    ['a future date stays plain', '2026-10-12', new Date(2026, 9, 9, 8, 0), 'Pending'],
    ['an unparseable date stays plain', '', new Date(2026, 9, 9, 8, 0), 'Pending'],
    // 12:30am 9 Oct Melbourne is still 8 Oct UTC: counts the LOCAL day, so 4 days, not 3.
    ['counts the local day just after midnight', '2026-10-05', new Date(2026, 9, 9, 0, 30), 'Pending · 4 days'],
    ['counts the local day just before midnight', '2026-10-05', new Date(2026, 9, 8, 23, 59), 'Pending'],
  ])('%s', (_name, dateIso, now, expected) => {
    expect(pendingLabel(dateIso, now)).toBe(expected);
  });
});

// WHIT-762 — one shared "Mon YYYY" label, hand-parsed from the ISO string so it never shifts a month.
describe('formatMonthYear', () => {
  it('labels an ISO date as "Mon YYYY"', () => {
    expect(formatMonthYear('2026-08-15')).toBe('Aug 2026');
  });

  it('passes an unparseable date through unchanged', () => {
    expect(formatMonthYear('not-a-date')).toBe('not-a-date');
    expect(formatMonthYear('2030-13-01')).toBe('2030-13-01');
    expect(formatMonthYear('2026-00-10')).toBe('2026-00-10');
    expect(formatMonthYear('')).toBe('');
  });

  it('labels a year-month without a day, or with a time on the end', () => {
    expect(formatMonthYear('2027-03')).toBe('Mar 2027');
    expect(formatMonthYear('2027-03-18T09:00:00Z')).toBe('Mar 2027');
  });
});

// WHIT-253: the shared UTC whole-day helpers behind cycleClock / paydaysUntil / the milestone
// schedule. Melbourne is UTC+10/+11, so a local midnight is the *previous* day in UTC — exactly
// what would break a getUTC* slip.
describe('isoToUtcDayMs', () => {
  it('parses an ISO date to its UTC-midnight timestamp', () => {
    expect(isoToUtcDayMs('2026-06-06')).toBe(Date.UTC(2026, 5, 6));
  });

  it('is NaN on an unparseable date (callers decide what that means)', () => {
    expect(Number.isNaN(isoToUtcDayMs('not-a-date'))).toBe(true);
  });
});

describe('utcDayMsToISO', () => {
  it('is the exact inverse of isoToUtcDayMs (round-trips the calendar day)', () => {
    for (const iso of ['2026-01-01', '2026-06-06', '2026-10-04', '2026-12-31']) {
      expect(utcDayMsToISO(isoToUtcDayMs(iso))).toBe(iso);
    }
  });

  it('is empty on NaN (an unparseable date), so callers render nothing', () => {
    expect(utcDayMsToISO(NaN)).toBe('');
    expect(utcDayMsToISO(isoToUtcDayMs('not-a-date'))).toBe('');
  });
});

describe('formatDayMonth', () => {
  it('formats an ISO date as "27 Aug" (no year), in local time', () => {
    expect(formatDayMonth('2026-08-27')).toBe('27 Aug');
    expect(formatDayMonth('2026-01-01')).toBe('1 Jan');
  });

  it('is empty on an empty/unparseable ISO (never "NaN undefined" on screen)', () => {
    expect(formatDayMonth('')).toBe('');
    expect(formatDayMonth('not-a-date')).toBe('');
  });
});

describe('formatDateRange', () => {
  const now = new Date(2026, 8, 27); // 27 Sep 2026

  it('leaves the year off a range inside the current year', () => {
    expect(formatDateRange('2026-06-12', '2026-09-11', now)).toBe('12 Jun – 11 Sep');
  });

  it('shows both years when the range crosses a year, so a full year never reads "20 Sep – 20 Sep"', () => {
    expect(formatDateRange('2025-09-20', '2026-09-20', now)).toBe('20 Sep 2025 – 20 Sep 2026');
  });

  it('shows the year for a range inside a past year, so last August never reads as this one', () => {
    expect(formatDateRange('2025-08-01', '2025-08-31', now)).toBe('1 Aug 2025 – 31 Aug 2025');
  });
});

describe('dateToUtcDayMs', () => {
  it('reads the LOCAL calendar day, not the UTC one', () => {
    // new Date(2026, 5, 6) is local midnight 6 Jun; under Melbourne TZ that instant is 5 Jun in
    // UTC. This fails if the helper ever slips to getUTCFullYear/getUTCMonth/getUTCDate.
    expect(dateToUtcDayMs(new Date(2026, 5, 6))).toBe(Date.UTC(2026, 5, 6));
  });
});

describe('wholeDaysBetween', () => {
  it('counts integer-exact whole days forward', () => {
    expect(wholeDaysBetween(isoToUtcDayMs('2026-06-06'), isoToUtcDayMs('2026-06-20'))).toBe(14);
  });

  it('counts exactly across a Melbourne daylight-saving change', () => {
    // Melbourne springs forward on Sun 2026-10-04. A device local day of 11 Oct,
    // 14 days after a 27 Sep payday, must still be exactly 14 whole days — not 13/15.
    expect(wholeDaysBetween(isoToUtcDayMs('2026-09-27'), dateToUtcDayMs(new Date(2026, 9, 11)))).toBe(14);
  });
});

const day = (y: number, m: number, d: number) => new Date(y, m - 1, d); // LOCAL calendar midnight

describe('cycleClock — Melbourne autumn fall-back', () => {
  const cycle = (length: number, last_pay_date: string) => ({ length, last_pay_date });

  it('counts whole calendar days exactly across Sun 5 Apr 2026 (03:00 -> 02:00)', () => {
    // pay 22 Mar, len 14. 5 Apr is exactly 14 days later -> fresh cycle -> daysLeft 14.
    expect(cycleClock(cycle(14, '2026-03-22'), day(2026, 4, 5)).daysLeft).toBe(14);
    // 5 Apr is also 7 days into a cycle anchored 29 Mar, spanning the change -> 7 left.
    expect(cycleClock(cycle(14, '2026-03-29'), day(2026, 4, 5)).daysLeft).toBe(7);
    // one day past the fall-back, still exact.
    expect(cycleClock(cycle(14, '2026-03-22'), day(2026, 4, 6)).daysLeft).toBe(13);
  });
});

describe('paydaysUntil — Melbourne spring forward', () => {
  it('does not shift the count across Sun 4 Oct 2026 (02:00 -> 03:00)', () => {
    // pay = today = 20 Sep, len 14 -> paydays 20 Sep, 4 Oct, 18 Oct. Window
    // (20 Sep, 18 Oct] spans the spring-forward and contains 4 Oct + 18 Oct = 2.
    expect(paydaysUntil({ length: 14, last_pay_date: '2026-09-20' }, '2026-10-18', day(2026, 9, 20))).toBe(2);
  });
});

// A LOCAL-midnight Date whose UTC day is the PREVIOUS calendar day: the dateToUtcDayMs
// local-component read inside milestoneView is what lands `t` back on the anchor. A getUTC* slip
// would push `t` a day earlier and interpolate off the anchor.
describe('milestoneView — schedule with a local-midnight `today` on an anchor', () => {
  it('lands exactly on the Sprint 1 anchor (expected balance == target) from a local Date', () => {
    const s1 = MILESTONES[1]; // Sprint 1: 420000 @ 2027-03-18
    const [y, m, d] = s1.targetDate.split('-').map(Number);
    const v = milestoneView(makeState({ homeLoan: { balance: 420000, asOf: null } }), day(y, m, d)).schedule!;
    expect(v.expectedBalance).toBe(s1.targetBalance); // 420000 exactly, not interpolated
    expect(v.deltaAmount).toBe(0);
    expect(v.onTrack).toBe(true);
    expect(v.ahead).toBe(false);
  });
});
