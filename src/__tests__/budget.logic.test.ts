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

// WHIT-69: an Income-bucket category's budget is an earn-target (a floor). Over is
// GOOD, so the direction and colours invert — never the red "over budget" branch —
// and income rows are kept OUT of the spend hero totals.
const RED = '#ff6b6b';
const income = (over = {}) => cat({ id: 'salary', name: 'Salary', color: '#35d9a0', bucket: 'Income', ...over });

describe('budgetViews — income earn-targets (over-is-good)', () => {
  // elapsed = 0.5, budget 5000 → linear target 2500.
  const state = (posted: number, pending = 0) => makeState({
    categories: [income()], budgets: [budget({ id: 'salary', budget: 5000, posted, pending })],
    cycleLen: 14, daysLeft: 7,
  });

  it('under target early in the cycle is never red and reads "to go"', () => {
    const row = budgetViews(state(1000)).rows[0];
    expect(row.over).toBe(false);
    expect(row.remainLabel).toBe('to go');
    expect(row.remainAmount).toBe('$4,000');       // 5000 - 1000 still to earn
    expect(row.remainColor).not.toBe(RED);
    expect(row.postedColor).not.toBe(RED);          // bar uses the category colour, not red
    expect(row.paceColor).not.toBe(RED);
    expect(row.paceLabel).toContain('to go');       // 2500 target vs 1000 earned → behind, but calm
  });

  it('ahead of the linear pace shows green "ahead of pace", still not met', () => {
    const row = budgetViews(state(3000)).rows[0];   // 3000 > 2500 target, < 5000 goal
    expect(row.paceLabel).toContain('ahead of pace');
    expect(row.paceColor).toBe('#35d9a0');
    expect(row.remainLabel).toBe('to go');
    expect(row.over).toBe(false);
  });

  it('meeting or exceeding the target is green and reads "over target"', () => {
    const row = budgetViews(state(6000)).rows[0];   // earned 6000 ≥ 5000 floor
    expect(row.remainLabel).toBe('over target');
    expect(row.remainAmount).toBe('$1,000');        // 6000 - 5000 over the floor
    expect(row.remainColor).toBe('#35d9a0');
    expect(row.paceLabel).toContain('over target');
    expect(row.over).toBe(false);
  });

  it('labels the earned/target amount as "earned", not "spent"', () => {
    expect(budgetViews(state(1000)).rows[0].spentLabel).toBe('$1,000 earned of $5,000');
    expect(budgetViews(state(1000, 200)).rows[0].spentLabel).toBe('$1,200 earned ($200 pending) of $5,000');
  });

  it('excludes income rows from the spend hero totals but still lists them', () => {
    const s = makeState({
      categories: [cat({ id: 'coffee' }), income()],
      budgets: [
        budget({ id: 'coffee', budget: 100, posted: 40, pending: 10 }),
        budget({ id: 'salary', budget: 5000, posted: 1000, pending: 0 }),
      ],
      cycleLen: 14, daysLeft: 7,
    });
    const { rows, totBudget, totSpent, totRemain } = budgetViews(s);
    expect(rows).toHaveLength(2);                    // income row is still listed
    expect(totBudget).toBe(100);                     // only the spend budget counts
    expect(totSpent).toBe(50);
    expect(totRemain).toBe(50);
  });
});

describe('budgetDetail — income earn-targets', () => {
  const detail = (posted: number) => budgetDetail(makeState({
    categories: [income()], budgets: [budget({ id: 'salary', budget: 5000, posted, pending: 0 })],
    cycleLen: 14, daysLeft: 7,
  }), 'salary')!;

  it('under target: calm "keep earning" status, never red, reframed daily label', () => {
    const d = detail(1000);
    expect(d.statusLabel).toBe('On track — keep earning');
    expect(d.statusColor).not.toBe(RED);
    expect(d.postedColor).not.toBe(RED);
    expect(d.dailyLabel).toContain('to target');    // "$X/day to target", not "Daily limit"
    expect(d.dailyLabel).not.toContain('Daily limit');
  });

  it('target reached: green status and no daily-to-go', () => {
    const d = detail(6000);
    expect(d.statusLabel).toBe('Target reached — nice');
    expect(d.statusColor).toBe('#35d9a0');
    expect(d.dailyLabel).toBe('Target reached');
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
