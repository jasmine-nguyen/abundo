// WHIT-630: the "what can I spend this cycle" formula and the pace target live once,
// in budgetMath.ts, so budgetViews / budgetDetail / spread eligibility can't drift apart.
import { describe, it, expect } from '@jest/globals';
import { nothingLeft, paceTarget, paceWarning, pacePct, paidInOneGo } from '../budgetMath';
import type { Transaction } from '../types';
import { txn } from './factory';

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

// WHIT-732: a budget reads "over plan" only when ahead of pace AND the daily room left is under
// half the daily plan.
describe('paceWarning', () => {
  const HALFWAY = { cycleLen: 14, daysLeft: 7 };
  const LAST_DAY = { cycleLen: 14, daysLeft: 0 };

  it.each([
    // available 140, 14-day cycle → plan $10/day, half = $5. 7 days left: $35 left == $5/day (strict <).
    ['exactly half the daily plan left is quiet', { spent: 105, target: 70, available: 140, over: false }, HALFWAY, false],
    ['a little less than half the daily plan left warns', { spent: 105.01, target: 70, available: 140, over: false }, HALFWAY, true],
    ['over budget → no pace warning', { spent: 150, target: 50, available: 100, over: true }, HALFWAY, false],
    ['ahead by exactly $0.50 → quiet, even with almost nothing left per day', { spent: 50.5, target: 50, available: 51, over: false }, HALFWAY, false],
    ['ahead by $0.51 with almost nothing left per day → warns', { spent: 50.51, target: 50, available: 51, over: false }, HALFWAY, true],
    // 0 days left: room left counts as one day. Half plan $5: $6 left → quiet; $4 left → warns.
    ['0 days left, $6 left → quiet', { spent: 134, target: 100, available: 140, over: false }, LAST_DAY, false],
    ['0 days left, $4 left → warns', { spent: 136, target: 100, available: 140, over: false }, LAST_DAY, true],
  ])('%s', (_case, row, clock, expected) => {
    expect(paceWarning(row, clock)).toBe(expected);
  });

  // WHIT-739: a bill paid in full by one charge has nothing to slow down.
  const MORTGAGE_CYCLE = { cycleLen: 30, daysLeft: 21 };
  const paid = { spent: 3667, target: 1100, available: 3667, over: false };

  it('one charge and $0 left → no warning', () => {
    expect(paceWarning({ ...paid, oneCharge: true }, MORTGAGE_CYCLE)).toBe(false);
  });

  it('no one-charge flag and $0 left → still warns', () => {
    expect(paceWarning(paid, MORTGAGE_CYCLE)).toBe(true);
  });

  it('one charge but $0.01 left, far ahead → still warns', () => {
    expect(paceWarning({ ...paid, spent: 3666.99, oneCharge: true }, MORTGAGE_CYCLE)).toBe(true);
  });
});

describe('pacePct — where the tick goes', () => {
  it('[A5] rounds and clamps to 0–100', () => {
    expect(pacePct(50, 200)).toBe(25);
    expect(pacePct(50, 160)).toBe(31);
    expect(pacePct(50, 40)).toBe(100);
    expect(pacePct(0, 100)).toBe(0);
  });
});

describe('paidInOneGo', () => {
  const charge = (id: string, amount: number, over: Partial<Transaction> = {}) =>
    txn({ transaction_id: id, category: 'mortgage', amount: -amount, ...over });

  it.each([
    ['no charges → not paid in one go', [], false],
    ['only an excluded charge → not paid in one go', [charge('a', 3667, { budget_excluded: true })], false],
    ['a charge that does not count to budget is ignored', [charge('a', 3667), charge('b', 5, { counts_to_budget: false })], true],
    ['two counting charges → not one go', [charge('a', 3000), charge('b', 667)], false],
  ])('%s', (_case, transactions, expected) => {
    expect(paidInOneGo(transactions)).toBe(expected);
  });
});

describe('nothingLeft — the cent boundary', () => {
  it.each([
    [3667, 3667, true],
    [3666.996, 3667, true],
    [3666.99, 3667, false],
    [3667.01, 3667, false],
  ])('spent %p of %p → %p', (spent, available, expected) => {
    expect(nothingLeft(spent, available)).toBe(expected);
  });
});
