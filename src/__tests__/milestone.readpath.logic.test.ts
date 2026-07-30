// Logic tests for the milestone read path (WHIT-367): milestoneView now reads the
// user's SAVED milestone plan (falling back to the built-in default when none is
// saved) instead of the hardcoded MILESTONES constant. Pure over the injected list —
// no provider/network. The saved MilestoneRecord shape has no `sprint`, so the step
// number is derived from list position.
import { describe, it, expect } from '@jest/globals';
import { milestoneView } from '../context';
import { MILESTONES } from '../milestones';
import type { MilestoneRecord } from '../api';
import { makeState } from './factory';

const onDate = (iso: string) => new Date(`${iso}T00:00:00Z`);

// A custom saved plan, deliberately different from the built-in default so the read
// path is observable: three steps, still strictly paid-down (decreasing balance, later
// dates). No `sprint` field — that's the whole point of MilestoneRecord.
const SAVED_PLAN: MilestoneRecord[] = [
  { id: 'a', label: 'Start',   targetBalance: 300000, targetDate: '2026-01-01' },
  { id: 'b', label: 'Midway',  targetBalance: 200000, targetDate: '2027-01-01' },
  { id: 'c', label: 'Payoff',  targetBalance: 100000, targetDate: '2028-01-01' },
];

describe('milestoneView — reads the saved plan (WHIT-367)', () => {
  it('drives rows/next/progress off the injected saved list, not the default', () => {
    const v = milestoneView(makeState({ milestones: SAVED_PLAN, homeLoan: { balance: 250000, asOf: null } }));
    // Three saved rows, not the default's five.
    expect(v.rows).toHaveLength(3);
    expect(v.rows.map((r) => r.label)).toEqual(['Start', 'Midway', 'Payoff']);
    expect(v.total).toBe(3);
    // 250k clears 'Start' (300k), next is 'Midway' (200k).
    expect(v.clearedCount).toBe(1);
    expect(v.nextMilestone?.label).toBe('Midway');
    expect(v.amountToNext).toBe(50000); // 250000 - 200000
    // overallPct runs from the saved start (300k) down to the saved end (100k):
    // (300000 - 250000) / (300000 - 100000) = 25%.
    expect(v.overallPct).toBe(25);
  });

  it('derives the step number from list position (saved rows carry no sprint)', () => {
    const v = milestoneView(makeState({ milestones: SAVED_PLAN, homeLoan: { balance: 250000, asOf: null } }));
    // The load-bearing line: sprint = array index, so the display "Sprint N" + React key
    // survive a MilestoneRecord that has no stored sprint.
    expect(v.rows.map((r) => r.sprint)).toEqual([0, 1, 2]);
  });

  it('interpolates the schedule between the saved anchors, not the default ones', () => {
    // Halfway (in time) between 'Start' (300k @ 2026-01-01) and 'Midway' (200k @ 2027-01-01)
    // the planned balance sits strictly inside (200k, 300k) — a default-plan curve would
    // give a different number, so this proves the injected anchors drive it.
    const s = milestoneView(makeState({ milestones: SAVED_PLAN, homeLoan: { balance: 260000, asOf: null } }), onDate('2026-07-01'));
    expect(s.schedule!.expectedBalance).toBeGreaterThan(200000);
    expect(s.schedule!.expectedBalance).toBeLessThan(300000);
  });
});

describe('milestoneView — falls back to the built-in default (no visible change)', () => {
  it('an empty saved list renders identically to omitting milestones', () => {
    const balance = { balance: 420000, asOf: null };
    const empty = milestoneView(makeState({ milestones: [], homeLoan: balance }));
    const omitted = milestoneView(makeState({ homeLoan: balance }));
    expect(empty.rows).toEqual(omitted.rows);
    expect(empty.overallPct).toBe(omitted.overallPct);
    expect(empty.nextMilestone).toEqual(omitted.nextMilestone);
    // …and that fallback IS the built-in default plan.
    expect(empty.rows).toHaveLength(MILESTONES.length);
    expect(empty.rows.map((r) => r.label)).toEqual(MILESTONES.map((m) => m.label));
    expect(empty.rows.map((r) => r.sprint)).toEqual([0, 1, 2, 3, 4]);
  });
});
