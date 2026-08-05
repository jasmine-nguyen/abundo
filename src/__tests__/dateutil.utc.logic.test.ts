// WHIT-253: the shared UTC whole-day helpers behind cycleClock / paydaysUntil /
// milestoneTime. Runs under TZ=Australia/Melbourne (see the test script) so the
// local-vs-UTC component reads and the daylight-saving-immunity are genuinely
// exercised — Melbourne is UTC+10/+11, so a local midnight is the *previous* day
// in UTC, which is exactly what would break a getUTC* slip.
import { describe, it, expect } from '@jest/globals';
import { isoToUtcDayMs, dateToUtcDayMs, wholeDaysBetween } from '../dateutil';
import { cycleClock, paydaysUntil, milestoneView } from '../context';
import { milestoneTime, MILESTONES } from '../milestones';
import { makeState } from './factory';

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

// WHIT-253 adversarial gaps — the extracted UTC helpers and their four call sites on inputs the
// other suites miss: dateToUtcDayMs ON both Melbourne DST transition days; cycleClock across the
// AUTUMN fall-back (WHIT-9 covers spring only); paydaysUntil across the SPRING forward (WHIT-232
// [A26] covers autumn only); milestoneView/milestoneTime fed a LOCAL-midnight Date whose UTC day
// differs from its local day. All hand-computed in Melbourne local time.
const day = (y: number, m: number, d: number) => new Date(y, m - 1, d); // LOCAL calendar midnight

describe('dateToUtcDayMs — on the Melbourne DST transition days', () => {
  it('autumn fall-back day (Sun 5 Apr 2026) still maps to that LOCAL day in UTC', () => {
    // Local midnight 5 Apr 2026 is 4 Apr 13:00 UTC (still +11, the fall-back is 03:00).
    // A getUTC* slip would read 4 Apr. Reading local components must yield 5 Apr.
    expect(dateToUtcDayMs(day(2026, 4, 5))).toBe(Date.UTC(2026, 3, 5));
  });

  it('spring-forward day (Sun 4 Oct 2026) still maps to that LOCAL day in UTC', () => {
    // Local midnight 4 Oct 2026 is 3 Oct 14:00 UTC (still +10, the change is 02:00).
    expect(dateToUtcDayMs(day(2026, 10, 4))).toBe(Date.UTC(2026, 9, 4));
  });
});

describe('wholeDaysBetween — autumn fall-back (mirror of the implementer spring test)', () => {
  it('counts exactly 14 whole days across Sun 5 Apr 2026 with a local device day', () => {
    // Payday 22 Mar; device local day 5 Apr = 14 days later; spans the fall-back.
    // Must be exactly 14 — a getUTC* slip on the `to` side would read 13.
    expect(wholeDaysBetween(isoToUtcDayMs('2026-03-22'), dateToUtcDayMs(day(2026, 4, 5)))).toBe(14);
  });
});

describe('cycleClock — Melbourne autumn fall-back (gap: WHIT-9 covers spring only)', () => {
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

describe('paydaysUntil — Melbourne spring forward (gap: [A26] covers autumn only)', () => {
  it('does not shift the count across Sun 4 Oct 2026 (02:00 -> 03:00)', () => {
    // pay = today = 20 Sep, len 14 -> paydays 20 Sep, 4 Oct, 18 Oct. Window
    // (20 Sep, 18 Oct] spans the spring-forward and contains 4 Oct + 18 Oct = 2.
    expect(paydaysUntil({ length: 14, last_pay_date: '2026-09-20' }, '2026-10-18', day(2026, 9, 20))).toBe(2);
  });
});

// Every existing milestone test builds `today` from a UTC-midnight instant whose local day == its
// UTC day in Melbourne. This feeds a LOCAL-midnight Date instead: its UTC day is the PREVIOUS
// calendar day, so the dateToUtcDayMs local-component read inside milestoneView is what lands `t`
// back on the anchor. A getUTC* slip would push `t` a day earlier and interpolate off the anchor.
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
  // NB: no Sprint-0 counterpart. Before the first anchor expectedBalanceAt clamps to
  // the Sprint-0 target (context.tsx:2041), so a getUTC* day-slip still returns 544000
  // — a Sprint-0 test can't fail-on-revert. Sprint 1 sits between anchors where the
  // curve interpolates, so the assertion above is the load-bearing local-read guard.
});

describe('milestoneTime — object form, string form and the raw helper agree', () => {
  it('object {targetDate} == bare string == isoToUtcDayMs, on a DST-boundary date', () => {
    const iso = '2026-10-04'; // spring-forward day, a value the milestone table never uses
    expect(milestoneTime({ targetDate: iso })).toBe(isoToUtcDayMs(iso));
    expect(milestoneTime(iso)).toBe(isoToUtcDayMs(iso));
    expect(milestoneTime({ targetDate: iso })).toBe(milestoneTime(iso));
  });

  it('every MILESTONES anchor via the object form equals the raw helper on its ISO', () => {
    for (const m of MILESTONES) {
      expect(milestoneTime(m)).toBe(isoToUtcDayMs(m.targetDate));
    }
  });
});
