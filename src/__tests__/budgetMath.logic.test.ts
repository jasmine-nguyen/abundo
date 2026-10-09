// WHIT-630: the "what can I spend this cycle" formula and the pace target live once,
// in budgetMath.ts, so budgetViews / budgetDetail / spread eligibility can't drift apart.
import { describe, it, expect } from '@jest/globals';
import { paceTarget } from '../budgetMath';

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
