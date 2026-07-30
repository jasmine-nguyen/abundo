// WHIT-367 GAPS (logic) — adversarial edges of the milestoneView saved-plan read path the
// implementer's milestone.readpath.logic.test.ts doesn't lock: overallPct clamp at BOTH ends
// over the SAVED anchors (not the default), and a single-row saved plan (plan[0] === plan[len-1]
// access) not throwing / not NaN-ing when the balance is below the lone target. Pure over the
// injected list — no provider/network.
import { describe, it, expect } from '@jest/globals';
import { milestoneView } from '../context';
import type { MilestoneRecord } from '../api';
import { makeState } from './factory';

const onDate = (iso: string) => new Date(`${iso}T00:00:00Z`);

// Strictly paid-down saved plan (decreasing balance, increasing date) — same shape the
// implementer uses, so overallPct's start/end come from 300k → 100k.
const SAVED_PLAN: MilestoneRecord[] = [
  { id: 'a', label: 'Start',  targetBalance: 300000, targetDate: '2026-01-01' },
  { id: 'b', label: 'Midway', targetBalance: 200000, targetDate: '2027-01-01' },
  { id: 'c', label: 'Payoff', targetBalance: 100000, targetDate: '2028-01-01' },
];

describe('milestoneView — overallPct clamps over the SAVED anchors (WHIT-367)', () => {
  it('clamps to 100 when the balance is below the saved final target (all cleared)', () => {
    // 50k < 100k (saved end) → raw pct 125 → clamped to 100. A clamp using the DEFAULT plan's
    // 55k end would give a different raw number, so the saved anchors are load-bearing here.
    const v = milestoneView(makeState({ milestones: SAVED_PLAN, homeLoan: { balance: 50000, asOf: null } }));
    expect(v.overallPct).toBe(100);
    expect(v.clearedCount).toBe(3);
    expect(v.nextMilestone).toBeNull();
    expect(v.amountToNext).toBe(0);
  });

  it('clamps to 0 when the balance is above the saved first target (nothing cleared)', () => {
    // 350k > 300k (saved start) → raw pct -25 → clamped to 0. Next is the saved first row.
    const v = milestoneView(makeState({ milestones: SAVED_PLAN, homeLoan: { balance: 350000, asOf: null } }));
    expect(v.overallPct).toBe(0);
    expect(v.clearedCount).toBe(0);
    expect(v.nextMilestone?.label).toBe('Start');
    expect(v.amountToNext).toBe(50000); // 350000 - 300000
  });
});

describe('milestoneView — a single-row saved plan (plan[0] === plan[len-1])', () => {
  // The read path indexes plan[0] and plan[plan.length-1]. With one saved row those are the
  // SAME element; below-target must still produce a finite, non-NaN view (not a crash), proving
  // the length-1 access is safe for the common "one milestone left" saved list.
  const SINGLE: MilestoneRecord[] = [
    { id: 'only', label: 'Only', targetBalance: 300000, targetDate: '2026-01-01' },
  ];

  it('renders one row keyed 0 and a finite view when the balance is below the lone target', () => {
    const v = milestoneView(makeState({ milestones: SINGLE, homeLoan: { balance: 250000, asOf: null } }), onDate('2026-07-01'));
    expect(v.rows).toHaveLength(1);
    expect(v.rows[0].sprint).toBe(0);
    expect(v.total).toBe(1);
    expect(v.clearedCount).toBe(1);        // 250k <= 300k
    expect(v.nextMilestone).toBeNull();    // the only target is cleared
    // start === end (300k) → zero span; the overallProgressPct guard returns 100 when the
    // balance is at or below the lone target, NOT NaN from a 0/0 division.
    expect(Number.isNaN(v.overallPct)).toBe(false);
    expect(v.overallPct).toBe(100);
    // schedule is flat before/after the single anchor — expectedBalance is the lone target,
    // never NaN from a zero-width interpolation segment.
    expect(v.schedule).not.toBeNull();
    expect(v.schedule!.expectedBalance).toBe(300000);
    expect(Number.isNaN(v.schedule!.deltaAmount)).toBe(false);
  });

  it('does NOT NaN when the balance sits EXACTLY on the lone target (the degenerate 0/0 edge)', () => {
    // This is the case the guard exists for: balance === start === end would be 0/0 → NaN without
    // the start===end short-circuit. Balance at the target counts as cleared → fully done (100).
    const v = milestoneView(makeState({ milestones: SINGLE, homeLoan: { balance: 300000, asOf: null } }));
    expect(Number.isNaN(v.overallPct)).toBe(false);
    expect(v.overallPct).toBe(100);
    expect(v.clearedCount).toBe(1);
  });
});
