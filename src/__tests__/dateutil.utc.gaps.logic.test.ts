// WHIT-253 — ADVERSARIAL GAP tests for the extracted UTC whole-day helpers and
// their four call sites. Independent of the implementer's dateutil.utc.logic.test.ts,
// the WHIT-9 cycleClock suite, the WHIT-232 balanceGoal.gaps suite and the WHIT-8
// milestone suites — this file ONLY covers what those miss, so the byte-for-byte
// extraction is proven behaviour-identical on inputs they don't exercise:
//   * dateToUtcDayMs ON both Melbourne DST transition days (existing tests use
//     non-DST June + a post-transition Oct day, never the transition day itself).
//   * cycleClock across the AUTUMN fall-back (the WHIT-9 suite only tests spring).
//   * paydaysUntil across the SPRING forward (the WHIT-232 gaps suite [A26] only
//     tests autumn).
//   * milestoneView's schedule fed a LOCAL-constructed `today` exactly on an anchor
//     (every existing milestone test builds `today` from a UTC-midnight instant, so
//     the dateToUtcDayMs local-component read inside milestoneView is never exercised
//     with a Date whose UTC day differs from its local day).
//   * milestoneTime object-form vs string-form vs the raw helper on a DST date.
// Runs under TZ=Australia/Melbourne (test script). Melbourne is UTC+10/+11, so a
// local midnight is the PREVIOUS calendar day in UTC — a getUTC* slip in any call
// site would move the day boundary and every assertion below is chosen to catch it.
// Every expected value is hand-computed and reasoned in Melbourne local time.
import { describe, it, expect } from '@jest/globals';
import { isoToUtcDayMs, dateToUtcDayMs, wholeDaysBetween } from '../dateutil';
import { cycleClock, paydaysUntil, milestoneView } from '../context';
import { milestoneTime, MILESTONES } from '../milestones';
import { makeState } from './factory';

const day = (y: number, m: number, d: number) => new Date(y, m - 1, d); // LOCAL calendar midnight

// --- dateToUtcDayMs ON a DST transition day (not just near one) --------------
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

// --- wholeDaysBetween across the AUTUMN fall-back with a LOCAL `to` -----------
describe('wholeDaysBetween — autumn fall-back (mirror of the implementer spring test)', () => {
  it('counts exactly 14 whole days across Sun 5 Apr 2026 with a local device day', () => {
    // Payday 22 Mar; device local day 5 Apr = 14 days later; spans the fall-back.
    // Must be exactly 14 — a getUTC* slip on the `to` side would read 13.
    expect(wholeDaysBetween(isoToUtcDayMs('2026-03-22'), dateToUtcDayMs(day(2026, 4, 5)))).toBe(14);
  });
});

// --- cycleClock across the AUTUMN fall-back (WHIT-9 only tests spring) --------
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

// --- paydaysUntil across the SPRING forward (WHIT-232 [A26] only tests autumn) -
describe('paydaysUntil — Melbourne spring forward (gap: [A26] covers autumn only)', () => {
  it('does not shift the count across Sun 4 Oct 2026 (02:00 -> 03:00)', () => {
    // pay = today = 20 Sep, len 14 -> paydays 20 Sep, 4 Oct, 18 Oct. Window
    // (20 Sep, 18 Oct] spans the spring-forward and contains 4 Oct + 18 Oct = 2.
    expect(paydaysUntil({ length: 14, last_pay_date: '2026-09-20' }, '2026-10-18', day(2026, 9, 20))).toBe(2);
  });
});

// --- milestoneView schedule fed a LOCAL Date exactly on an anchor ------------
// Every existing milestone test builds `today` from `new Date(\`\${iso}T00:00:00Z\`)`
// (a UTC-midnight instant whose local day == its UTC day in Melbourne). This feeds
// a LOCAL-midnight Date instead: its UTC day is the PREVIOUS calendar day, so the
// dateToUtcDayMs local-component read inside milestoneView is what lands `t` back on
// the anchor. A getUTC* slip would push `t` a day earlier and the expected balance
// would interpolate off the exact anchor value.
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

// --- milestoneTime routing/behaviour parity ---------------------------------
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
