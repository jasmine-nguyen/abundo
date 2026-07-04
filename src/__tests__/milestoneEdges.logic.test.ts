// Adversarial GAP tests for milestoneView (WHIT-8) — edges the implementer's
// milestone.logic.test.ts does not lock: the schedule curve AT/BEYOND the final
// Sprint 4 anchor (the "flat after last" branch of expectedBalanceAt), the
// delta==0 boundary (must be onTrack AND ahead:false, guarding `delta > 0` vs
// `>=`), and the "already past the final target but before its date" combo
// (overallPct pinned 100 while genuinely ahead, no next milestone).
// Pure over s.homeLoan + MILESTONES + injected `today`; no provider/network.
import { describe, it, expect } from '@jest/globals';
import { milestoneView } from '../context';
import { MILESTONES } from '../milestones';
import { makeState } from './factory';

const onDate = (iso: string) => new Date(`${iso}T00:00:00Z`);
const withBalance = (balance: number) => makeState({ homeLoan: { balance, asOf: null } });

const FINAL = MILESTONES[MILESTONES.length - 1];       // Sprint 4: 55000 @ 2029-06-18

describe('milestoneView — schedule at and beyond the final anchor', () => {
  it('holds the planned balance flat AT the final Sprint date (delta 0 => on track)', () => {
    // On the last anchor the expected balance is exactly the final target. A
    // balance equal to it is delta 0: on track, and explicitly NOT "ahead".
    const v = milestoneView(withBalance(FINAL.targetBalance), onDate(FINAL.targetDate)).schedule!;
    expect(v.expectedBalance).toBe(FINAL.targetBalance);   // 55000
    expect(v.deltaAmount).toBe(0);
    expect(v.onTrack).toBe(true);
    expect(v.ahead).toBe(false);                            // guards `delta > 0`, not `>=`
    expect(v.label).toBe('On track with the plan');
  });

  it('keeps the planned balance flat BEYOND the final Sprint date (no extrapolation)', () => {
    // Well past 2029-06-18 the curve must not keep dropping below 55000; it clamps.
    const v = milestoneView(withBalance(FINAL.targetBalance), onDate('2035-01-01')).schedule!;
    expect(v.expectedBalance).toBe(FINAL.targetBalance);   // still 55000, not < 0
    expect(v.onTrack).toBe(true);
  });
});

describe('milestoneView — delta 0 boundary before Sprint 0', () => {
  it('a balance exactly on the flat pre-Sprint-0 plan is on track, not ahead', () => {
    // Before the first anchor the expected balance is the Sprint 0 target.
    const start = MILESTONES[0].targetBalance;             // 544000
    const v = milestoneView(withBalance(start), onDate('2026-01-01')).schedule!;
    expect(v.expectedBalance).toBe(start);
    expect(v.deltaAmount).toBe(0);
    expect(v.ahead).toBe(false);
    expect(v.onTrack).toBe(true);
    expect(v.label).toBe('On track with the plan');
  });
});

describe('milestoneView — under the final target before its date', () => {
  it('caps overallPct at 100 while reporting genuinely ahead and no next milestone', () => {
    // Balance already below the Sprint 4 target, but "today" sits between Sprint 0
    // and Sprint 1 so the plan still expects a high balance => far ahead.
    const v = milestoneView(withBalance(40000), onDate('2027-01-01'));
    expect(v.overallPct).toBe(100);           // clamped, never > 100
    expect(v.clearedCount).toBe(5);
    expect(v.nextMilestone).toBeNull();
    expect(v.amountToNextLabel).toBe('—');    // no next => em dash, not "$0"
    expect(v.schedule!.ahead).toBe(true);
    expect(v.schedule!.onTrack).toBe(false);
    expect(v.schedule!.label).toMatch(/ahead of schedule$/);
  });
});
