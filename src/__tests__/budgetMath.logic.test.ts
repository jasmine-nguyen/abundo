// WHIT-630: the "what can I spend this cycle" formula and the pace target live once,
// in budgetMath.ts, so budgetViews / budgetDetail / spread eligibility can't drift apart.
import { describe, it, expect } from '@jest/globals';
import { availableToSpend, paceTarget } from '../budgetMath';

const parts = (over: Partial<{ available: number; budget: number; rollover: boolean; carryover: number; spreadAdjustment: number }> = {}) => ({
  budget: 400,
  rollover: false,
  carryover: 0,
  spreadAdjustment: 0,
  ...over,
});

describe('availableToSpend', () => {
  it('uses the server-computed spendable when present', () => {
    expect(availableToSpend(parts({ available: 525, carryover: 90, rollover: true }))).toBe(525);
  });

  it('keeps a server 0 rather than falling back to the parts-sum', () => {
    expect(availableToSpend(parts({ available: 0 }))).toBe(0);
  });

  it('falls back to budget + carryover when rollover is on and the server value is missing', () => {
    expect(availableToSpend(parts({ rollover: true, carryover: 120 }))).toBe(520);
    expect(availableToSpend(parts({ rollover: true, carryover: -150 }))).toBe(250);
  });

  it('ignores carryover when rollover is off', () => {
    expect(availableToSpend(parts({ rollover: false, carryover: 120 }))).toBe(400);
  });

  it('applies a bill-spread adjustment', () => {
    expect(availableToSpend(parts({ spreadAdjustment: 60 }))).toBe(460);
    expect(availableToSpend(parts({ spreadAdjustment: -75 }))).toBe(325);
  });
});

describe('paceTarget', () => {
  it('is 0 on the first day of a fresh cycle', () => {
    expect(paceTarget({ budget: 280 }, { cycleLen: 14, daysLeft: 14 })).toBe(0);
  });

  it('is the elapsed share of the base target mid-cycle', () => {
    expect(paceTarget({ budget: 280 }, { cycleLen: 14, daysLeft: 7 })).toBe(140);
    expect(paceTarget({ budget: 280 }, { cycleLen: 14, daysLeft: 10 })).toBe(80);
  });

  it('is the whole target on the last day', () => {
    expect(paceTarget({ budget: 280 }, { cycleLen: 14, daysLeft: 0 })).toBe(280);
  });
});
