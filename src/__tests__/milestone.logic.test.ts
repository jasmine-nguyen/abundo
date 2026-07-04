// Logic tests for milestoneView (WHIT-8) — the Sprint 0–4 paydown progress
// selector. Pure over the live home-loan balance (s.homeLoan) + the MILESTONES
// constants + an injected `today`, so no provider/network is needed.
import { describe, it, expect } from '@jest/globals';
import { milestoneView } from '../context';
import { MILESTONES, PROPERTY_VALUE, HOME_LOAN_LVR, milestoneTime, usableEquity } from '../milestones';
import { makeState } from './factory';

// A UTC-midnight Date the selector reads via get*()/Date.UTC — matches how the
// milestone dates are compared. Passing the milestone's own ISO gives a `today`
// exactly on that anchor.
const onDate = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe('MILESTONES constants', () => {
  it('are strictly ordered: increasing dates, decreasing balances', () => {
    for (let i = 1; i < MILESTONES.length; i++) {
      expect(milestoneTime(MILESTONES[i])).toBeGreaterThan(milestoneTime(MILESTONES[i - 1]));
      expect(MILESTONES[i].targetBalance).toBeLessThan(MILESTONES[i - 1].targetBalance);
    }
  });

  it('match the Notion usable-equity figures (property value + LVR pin)', () => {
    // Sprint 0: 770000 * 0.8 - 544000 = 72000; Sprint 4: -> 561000.
    expect(usableEquity(PROPERTY_VALUE, 544000)).toBe(72000);
    expect(usableEquity(PROPERTY_VALUE, 55000)).toBe(561000);
    expect(HOME_LOAN_LVR).toBe(0.8);
  });
});

describe('milestoneView — no balance yet', () => {
  it('flags hasBalance false, nulls the schedule, and shows em-dash labels', () => {
    const v = milestoneView(makeState({ homeLoan: { balance: null, asOf: null } }));
    expect(v.hasBalance).toBe(false);
    expect(v.schedule).toBeNull();
    expect(v.balanceLabel).toBe('—');
    expect(v.usableEquityLabel).toBe('—');
    expect(v.amountToNextLabel).toBe('—');
    expect(v.clearedCount).toBe(0);
    expect(v.rows).toHaveLength(5);
    expect(v.rows.every((r) => !r.cleared)).toBe(true);
  });
});

describe('milestoneView — usable equity', () => {
  it('derives equity from the property value and LVR, clamped ≥ 0', () => {
    const v = milestoneView(makeState({ homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:24:37.614Z' } }));
    // 770000 * 0.8 - 596642.43 = 19357.57 -> round 19358
    expect(v.usableEquity).toBe(19358);
    expect(v.usableEquityLabel).toBe('$19,358');
  });

  it('never goes negative when the balance exceeds borrowing power', () => {
    const v = milestoneView(makeState({ homeLoan: { balance: 700000, asOf: null } }));
    expect(v.usableEquity).toBe(0);
  });
});

describe('milestoneView — next milestone selection', () => {
  it('picks Sprint 0 when the balance is still above every target', () => {
    const v = milestoneView(makeState({ homeLoan: { balance: 596642.43, asOf: null } }));
    expect(v.clearedCount).toBe(0);
    expect(v.nextMilestone?.sprint).toBe(0);
    expect(v.amountToNext).toBeCloseTo(52642.43, 2); // 596642.43 - 544000
  });

  it('counts a target reached at-or-below as cleared and advances the next one', () => {
    // 420000 clears Sprint 0 (544k) and Sprint 1 (420k, inclusive), next is Sprint 2 (295k).
    const v = milestoneView(makeState({ homeLoan: { balance: 420000, asOf: null } }));
    expect(v.clearedCount).toBe(2);
    expect(v.nextMilestone?.sprint).toBe(2);
    expect(v.amountToNext).toBe(125000); // 420000 - 295000
  });

  it('returns no next milestone once the final target is reached', () => {
    const v = milestoneView(makeState({ homeLoan: { balance: 40000, asOf: null } }));
    expect(v.clearedCount).toBe(5);
    expect(v.nextMilestone).toBeNull();
    expect(v.amountToNextLabel).toBe('—');
    expect(v.overallPct).toBe(100);
  });
});

describe('milestoneView — overall progress', () => {
  it('is 0% at the Sprint 0 balance and clamps below 0', () => {
    expect(milestoneView(makeState({ homeLoan: { balance: 544000, asOf: null } })).overallPct).toBe(0);
    // Above the start balance clamps to 0 rather than going negative.
    expect(milestoneView(makeState({ homeLoan: { balance: 600000, asOf: null } })).overallPct).toBe(0);
  });

  it('is 100% at the final target', () => {
    expect(milestoneView(makeState({ homeLoan: { balance: 55000, asOf: null } })).overallPct).toBe(100);
  });
});

describe('milestoneView — schedule verdict (ahead / behind / on track)', () => {
  it('reads the planned balance flat before Sprint 0', () => {
    const state = (balance: number) => makeState({ homeLoan: { balance, asOf: null } });
    const early = onDate('2026-01-01'); // before Sprint 0 (2026-06-18) -> expected 544000
    expect(milestoneView(state(544000), early).schedule).toMatchObject({ onTrack: true, expectedBalance: 544000 });
    expect(milestoneView(state(500000), early).schedule).toMatchObject({ ahead: true });
    expect(milestoneView(state(600000), early).schedule).toMatchObject({ ahead: false });
  });

  it('reads the planned balance exactly on a Sprint anchor date', () => {
    const state = (balance: number) => makeState({ homeLoan: { balance, asOf: null } });
    const s1 = onDate('2027-03-18'); // Sprint 1 -> expected 420000
    expect(milestoneView(state(420000), s1).schedule?.expectedBalance).toBe(420000);
    expect(milestoneView(state(400000), s1).schedule).toMatchObject({ ahead: true });
    const behind = milestoneView(state(450000), s1).schedule!;
    expect(behind.ahead).toBe(false);
    expect(behind.deltaAmount).toBe(30000);
    expect(behind.label).toBe('$30,000 behind schedule');
  });

  it('interpolates strictly between two anchors', () => {
    // Between Sprint 0 (544k @ 2026-06-18) and Sprint 1 (420k @ 2027-03-18) the
    // expected balance sits strictly inside (420k, 544k).
    const mid = milestoneView(makeState({ homeLoan: { balance: 500000, asOf: null } }), onDate('2026-10-01')).schedule!;
    expect(mid.expectedBalance).toBeGreaterThan(420000);
    expect(mid.expectedBalance).toBeLessThan(544000);
  });

  it('treats a balance within ~$100 of plan as on track', () => {
    const v = milestoneView(makeState({ homeLoan: { balance: 543950, asOf: null } }), onDate('2026-01-01'));
    expect(v.schedule).toMatchObject({ onTrack: true, label: 'On track with the plan' });
  });
});
