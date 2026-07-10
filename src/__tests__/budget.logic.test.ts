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

// WHIT-201: a Savings-bucket budget has no meaningful rollup (savings is an account
// balance, not categorised spend), so budgetViews skips it entirely — row AND totals —
// and budgetDetail treats it as absent. New Savings budgets are blocked in the picker;
// this covers one set before that / via re-bucketing.
describe('budgetViews — Savings budgets are skipped (WHIT-201)', () => {
  it('omits a Savings budget row and excludes it from the hero totals, while other buckets still render', () => {
    const s = makeState({
      categories: [
        cat({ id: 'coffee', bucket: 'Lifestyle' }),
        cat({ id: 'salary', name: 'Salary', bucket: 'Income' }),
        cat({ id: 'nest_egg', name: 'Nest Egg', bucket: 'Savings' }),
      ],
      budgets: [
        budget({ id: 'coffee', budget: 100, posted: 40, pending: 10 }),
        budget({ id: 'salary', budget: 5000, posted: 1000, pending: 0 }),
        budget({ id: 'nest_egg', budget: 2000, posted: 0, pending: 0 }),
      ],
      cycleLen: 14, daysLeft: 7,
    });
    const { rows, totBudget, totSpent, totRemain } = budgetViews(s);
    expect(rows.map((r) => r.id)).toEqual(['coffee', 'salary']);  // no nest_egg row
    // Totals are the spend row only (income is excluded too, per WHIT-69); the $2000
    // Savings target must NOT leak into totBudget.
    expect(totBudget).toBe(100);
    expect(totSpent).toBe(50);
    expect(totRemain).toBe(50);
  });
});

describe('budgetDetail', () => {
  it('returns null when the category or budget is missing', () => {
    expect(budgetDetail(makeState(), 'nope')).toBeNull();
  });

  it('returns null for a Savings-bucket budget (WHIT-201)', () => {
    const s = makeState({
      categories: [cat({ id: 'nest_egg', name: 'Nest Egg', bucket: 'Savings' })],
      budgets: [budget({ id: 'nest_egg', budget: 2000, posted: 0, pending: 0 })],
      cycleLen: 14, daysLeft: 7,
    });
    expect(budgetDetail(s, 'nest_egg')).toBeNull();
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

describe('budgetViews sub-category tree + hero de-dup (WHIT-221)', () => {
  const car = () => cat({ id: 'car', name: 'Car', bucket: 'Living', parent: null });
  const parking = () => cat({ id: 'parking', name: 'Parking', bucket: 'Living', parent: 'car' });

  it('de-dups the hero total: a parent and its budgeted sub count the parent ONCE', () => {
    // Car (parent) rolled-up spend £75 (server-folded Parking+Other); Parking budgeted £50/£30.
    // Fail-on-revert: dropping the `depth === 0` guard makes this read 105 / 250.
    const s = makeState({
      categories: [car(), parking()],
      budgets: [budget({ id: 'car', budget: 200, posted: 75, pending: 0 }),
                budget({ id: 'parking', budget: 50, posted: 30, pending: 0 })],
      cycleLen: 14, daysLeft: 7,
    });
    const { rows, totBudget, totSpent, totRemain } = budgetViews(s);
    expect(totSpent).toBe(75);   // only Car — Parking is already inside Car's roll-up
    expect(totBudget).toBe(200); // only Car's cap
    expect(totRemain).toBe(125);
    // both rows present, ordered parent-then-child, with depth/parentId set
    expect(rows.map((r) => r.id)).toEqual(['car', 'parking']);
    expect(rows[0]).toMatchObject({ id: 'car', depth: 0, parentId: null });
    expect(rows[1]).toMatchObject({ id: 'parking', depth: 1, parentId: 'car' });
  });

  it('counts only the top of a 3-level chain; depth increases per level', () => {
    const s = makeState({
      categories: [car(),
                   cat({ id: 'daily', bucket: 'Living', parent: 'car' }),
                   cat({ id: 'petrol', bucket: 'Living', parent: 'daily' })],
      budgets: [budget({ id: 'car', budget: 200, posted: 75, pending: 0 }),
                budget({ id: 'daily', budget: 100, posted: 60, pending: 0 }),
                budget({ id: 'petrol', budget: 40, posted: 30, pending: 0 })],
      cycleLen: 14, daysLeft: 7,
    });
    const { rows, totSpent, totBudget } = budgetViews(s);
    expect(totSpent).toBe(75);   // only the top-most (car)
    expect(totBudget).toBe(200);
    expect(rows.map((r) => [r.id, r.depth])).toEqual([['car', 0], ['daily', 1], ['petrol', 2]]);
  });

  it('walks through an UN-budgeted middle node to find the budgeted ancestor', () => {
    // car budgeted, daily NOT budgeted, petrol budgeted under daily. petrol's nearest
    // budgeted ancestor is car → it nests under car at depth 1 and is skipped from the hero.
    const s = makeState({
      categories: [car(),
                   cat({ id: 'daily', bucket: 'Living', parent: 'car' }),
                   cat({ id: 'petrol', bucket: 'Living', parent: 'daily' })],
      budgets: [budget({ id: 'car', budget: 200, posted: 75, pending: 0 }),
                budget({ id: 'petrol', budget: 40, posted: 30, pending: 0 })],
      cycleLen: 14, daysLeft: 7,
    });
    const { rows, totSpent } = budgetViews(s);
    expect(totSpent).toBe(75); // petrol skipped (has a budgeted ancestor)
    expect(rows.map((r) => r.id)).toEqual(['car', 'petrol']);
    expect(rows[1]).toMatchObject({ id: 'petrol', depth: 1, parentId: 'car' });
  });

  it('counts a budgeted sub whose parent is NOT budgeted, at top level', () => {
    // car has no budget row (target 0 → absent from budgets[]); parking budgeted under it.
    const s = makeState({
      categories: [car(), parking()],
      budgets: [budget({ id: 'parking', budget: 50, posted: 30, pending: 0 })],
      cycleLen: 14, daysLeft: 7,
    });
    const { rows, totSpent, totBudget } = budgetViews(s);
    expect(totSpent).toBe(30);   // no budgeted ancestor → counts
    expect(totBudget).toBe(50);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'parking', depth: 0, parentId: null });
  });

  it('keeps Income parent/sub out of the spend hero but still nests them', () => {
    const s = makeState({
      categories: [cat({ id: 'income', bucket: 'Income', parent: null }),
                   cat({ id: 'salary', bucket: 'Income', parent: 'income' })],
      budgets: [budget({ id: 'income', budget: 6000, posted: 4000, pending: 0 }),
                budget({ id: 'salary', budget: 5000, posted: 4000, pending: 0 })],
      cycleLen: 14, daysLeft: 7,
    });
    const { rows, totSpent, totBudget } = budgetViews(s);
    expect(totSpent).toBe(0);    // income never enters the spend hero
    expect(totBudget).toBe(0);
    expect(rows.map((r) => [r.id, r.depth])).toEqual([['income', 0], ['salary', 1]]);
  });
});
