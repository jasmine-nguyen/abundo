// Budget selectors: elapsedFrac, budgetViews (the list bars + pace copy) and
// budgetDetail (the single-category screen). These drive every number and colour
// on the budgets screens, so they're the highest-value regression lock.
import { describe, it, expect } from '@jest/globals';
import { elapsedFrac, budgetViews, budgetDetail } from '../context';
import { makeState, cat, budget, txn } from './factory';

describe('elapsedFrac', () => {
  it('is (cycleLen - daysLeft) / cycleLen', () => {
    expect(elapsedFrac(makeState({ cycleLen: 14, daysLeft: 7 }))).toBeCloseTo(0.5, 5);
    expect(elapsedFrac(makeState({ cycleLen: 14, daysLeft: 14 }))).toBe(0); // fresh cycle
    expect(elapsedFrac(makeState({ cycleLen: 14, daysLeft: 0 }))).toBe(1);  // cycle ended
  });
});

describe('budgetViews', () => {
  const base = () => makeState({
    categories: [cat({ id: 'coffee', name: 'Cafes & Coffee', color: '#E8A87C' })],
    cycleLen: 14, daysLeft: 7, // elapsed = 0.5
  });

  it('sums posted + pending as spend and computes remaining', () => {
    const s = makeState({ ...{}, categories: [cat()], budgets: [budget({ id: 'coffee', budget: 100, posted: 40, pending: 10 })], cycleLen: 14, daysLeft: 7 });
    const { rows, totBudget, totSpent, totRemain } = budgetViews(s);
    expect(totBudget).toBe(100);
    expect(totSpent).toBe(50);
    expect(totRemain).toBe(50);
    expect(rows).toHaveLength(1);
  });

  it('splits the bar into posted% and pending% within the budget', () => {
    const s = makeState({ categories: [cat()], budgets: [budget({ budget: 100, posted: 40, pending: 10 })], cycleLen: 14, daysLeft: 7 });
    const [row] = budgetViews(s).rows;
    expect(row.postedPct).toBeCloseTo(40, 5);
    expect(row.pendingPct).toBeCloseTo(10, 5);
    expect(row.over).toBe(false);
  });

  it('caps the pending segment so posted% + pending% never exceeds 100', () => {
    // posted 90 + pending 40 = 130 of 100 → over budget; bars must still sum to <= 100.
    const s = makeState({ categories: [cat()], budgets: [budget({ budget: 100, posted: 90, pending: 40 })], cycleLen: 14, daysLeft: 7 });
    const [row] = budgetViews(s).rows;
    expect(row.over).toBe(true);
    expect(row.postedPct + row.pendingPct).toBeLessThanOrEqual(100.0001);
    expect(row.paceLabel).toContain('over budget');
  });

  it('labels pace relative to the linear target (elapsed * budget)', () => {
    // elapsed 0.5, budget 100 → target 50.
    const under = budgetViews(makeState({ categories: [cat()], budgets: [budget({ budget: 100, posted: 20, pending: 0 })], cycleLen: 14, daysLeft: 7 })).rows[0];
    expect(under.paceLabel).toContain('under pace');
    const over = budgetViews(makeState({ categories: [cat()], budgets: [budget({ budget: 100, posted: 80, pending: 0 })], cycleLen: 14, daysLeft: 7 })).rows[0];
    expect(over.paceLabel).toContain('over pace');
    expect(over.over).toBe(false); // over PACE, not over budget
  });

  it('shows the pending amount in the spent label only when pending > 0', () => {
    const withPending = budgetViews(makeState({ categories: [cat()], budgets: [budget({ budget: 100, posted: 40, pending: 10 })], cycleLen: 14, daysLeft: 7 })).rows[0];
    expect(withPending.spentLabel).toContain('pending');
    const noPending = budgetViews(makeState({ categories: [cat()], budgets: [budget({ budget: 100, posted: 40, pending: 0 })], cycleLen: 14, daysLeft: 7 })).rows[0];
    expect(noPending.spentLabel).not.toContain('pending');
  });

  it('skips a budget whose category no longer exists', () => {
    const s = makeState({ categories: [cat({ id: 'coffee' })], budgets: [budget({ id: 'ghost', budget: 50, posted: 0, pending: 0 })], cycleLen: 14, daysLeft: 7 });
    expect(budgetViews(s).rows).toHaveLength(0);
  });
});

describe('budgetDetail', () => {
  it('returns null when the category or budget is missing', () => {
    expect(budgetDetail(makeState(), 'nope')).toBeNull();
  });

  it('pluralises the days-remaining label (1 day vs N days)', () => {
    const s1 = makeState({ categories: [cat()], budgets: [budget()], cycleLen: 14, daysLeft: 1 });
    expect(budgetDetail(s1, 'coffee')!.daysLeftLabel).toBe('1 day remaining');
    const s2 = makeState({ categories: [cat()], budgets: [budget()], cycleLen: 14, daysLeft: 5 });
    expect(budgetDetail(s2, 'coffee')!.daysLeftLabel).toBe('5 days remaining');
  });

  it('computes a daily limit from remaining / days left, and $0 when over', () => {
    const ok = budgetDetail(makeState({ categories: [cat()], budgets: [budget({ budget: 100, posted: 30, pending: 0 })], cycleLen: 14, daysLeft: 7 }), 'coffee')!;
    expect(ok.dailyLabel).toBe('Daily limit: $10'); // (100-30)/7 = 10
    const over = budgetDetail(makeState({ categories: [cat()], budgets: [budget({ budget: 100, posted: 130, pending: 0 })], cycleLen: 14, daysLeft: 7 }), 'coffee')!;
    expect(over.dailyLabel).toBe('Daily limit: $0');
    expect(over.statusLabel).toContain('Over budget');
  });

  it('lists related transactions grouped, and flags empty', () => {
    const withTx = budgetDetail(makeState({
      categories: [cat()], budgets: [budget()], cycleLen: 14, daysLeft: 7,
      transactions: [txn({ transaction_id: 'x', category: 'coffee', date: '2026-05-01' })],
    }), 'coffee')!;
    expect(withTx.relEmpty).toBe(false);
    expect(withTx.relGroups.length).toBeGreaterThan(0);
    const noTx = budgetDetail(makeState({ categories: [cat()], budgets: [budget()], cycleLen: 14, daysLeft: 7 }), 'coffee')!;
    expect(noTx.relEmpty).toBe(true);
  });
});
