// WHIT-314 GAPS (logic) — the totEarnedBudget accumulator + selectBudgetedTotals de-dup that
// the implementer's happy-path suites don't reach: corrupt cross-bucket parent links, an
// income/spend mixed family, child-before-parent income ordering, a spend-family regression
// guard that income never leaks in, a deleted (no-category) budget id, and the target<=0 drop.
// All pure — reads the REAL budgetViews / selectBudgetedTotals / selectBudgets, so each FAILS
// if the de-dup or the income accumulator regresses.
import { describe, it, expect } from '@jest/globals';
import { budgetViews } from '../context';
import type { BudgetRollup } from '../api';
import { selectBudgets, selectBudgetedTotals } from '../queries';
import { makeState, cat, budget } from './factory';

describe('budgetViews.totEarnedBudget — cross-bucket + mixed-family de-dup (WHIT-314 gaps)', () => {
  // [G1] A corrupt cross-bucket link: an Income child nested under a budgeted SPEND parent.
  // The same-bucket guard in walkBudgetedAncestors means the income child keeps depth 0, so it
  // must be COUNTED ONCE in totEarnedBudget (never silently de-duped away under a spend parent),
  // and the spend parent's totBudget is untouched by the income change.
  it('[G1] an income child under a budgeted spend parent still counts once in totEarnedBudget', () => {
    const s = makeState({
      categories: [
        cat({ id: 'shop', bucket: 'Lifestyle', parent: null }),        // budgeted SPEND parent
        cat({ id: 'tips', bucket: 'Income', parent: 'shop' }),         // Income child, corrupt cross-bucket nest
      ],
      budgets: [budget({ id: 'shop', budget: 500 }), budget({ id: 'tips', budget: 300, posted: 0, pending: 0 })],
    });
    const v = budgetViews(s);
    expect(v.totEarnedBudget).toBe(300); // income counted on its own, NOT dropped under the spend parent
    expect(v.totBudget).toBe(500);       // spend parent only; income never leaks into the spend total
  });

  // [G2] An Income parent with a (cross-bucket) SPEND child, both budgeted. The two live in
  // different buckets, so neither de-dups the other: income → totEarnedBudget, spend → totBudget.
  it('[G2] an income parent + a spend child are counted in their own totals, independently', () => {
    const s = makeState({
      categories: [
        cat({ id: 'salary', bucket: 'Income', parent: null }),
        cat({ id: 'coffee', bucket: 'Lifestyle', parent: 'salary' }), // spend child under an income parent
      ],
      budgets: [budget({ id: 'salary', budget: 5000, posted: 0, pending: 0 }), budget({ id: 'coffee', budget: 400 })],
    });
    const v = budgetViews(s);
    expect(v.totEarnedBudget).toBe(5000);
    expect(v.totBudget).toBe(400);
  });

  // [G3] Regression guard: a normal SPEND parent+child family (same bucket) still de-dups the
  // spend total to the parent AND leaves totEarnedBudget at 0 — the income accumulator must not
  // pick anything up from a pure-spend family after the WHIT-314 change.
  it('[G3] a same-bucket spend parent+child de-dups totBudget to the parent, totEarnedBudget stays 0', () => {
    const s = makeState({
      categories: [
        cat({ id: 'car', bucket: 'Living', parent: null }),
        cat({ id: 'parking', bucket: 'Living', parent: 'car' }),
      ],
      budgets: [budget({ id: 'car', budget: 200 }), budget({ id: 'parking', budget: 50 })],
    });
    const v = budgetViews(s);
    expect(v.totBudget).toBe(200);       // parent only, sub folded in (WHIT-221)
    expect(v.totEarnedBudget).toBe(0);   // no income leak
  });

  // [G4] Income de-dup is order-independent (the two-pass exists for exactly this): a budgeted
  // income CHILD listed BEFORE its budgeted income parent still resolves to depth 1 and only the
  // depth-0 parent is summed. Mirrors the spend two-pass test, but for the new income total.
  it('[G4] a nested income child listed BEFORE its parent still counts only the parent', () => {
    const s = makeState({
      categories: [
        cat({ id: 'salary', bucket: 'Income', parent: null }),
        cat({ id: 'bonus', bucket: 'Income', parent: 'salary' }),
      ],
      budgets: [ // child FIRST — the ordering the single-pass would have under-de-duped
        budget({ id: 'bonus', budget: 800, posted: 0, pending: 0 }),
        budget({ id: 'salary', budget: 5000, posted: 0, pending: 0 }),
      ],
    });
    expect(budgetViews(s).totEarnedBudget).toBe(5000);
  });
});

describe('selectBudgetedTotals — deleted category + target<=0 pipeline (WHIT-314 gaps)', () => {
  const CATS = [
    { id: 'coffee', name: 'Coffee', icon: 'coffee', color: '#E8A87C', bucket: 'Lifestyle' as const, recent: 0 },
    { id: 'salary', name: 'Salary', icon: 'cash', color: '#2ac3de', bucket: 'Income' as const, recent: 0 },
  ];
  const category = (id: string) => CATS.find((c) => c.id === id);
  const b = (id: string, amount: number) => ({ id, budget: amount, posted: 0, pending: 0 });

  // [G5] A budget id whose category was deleted (no taxonomy match). budgetViews must SKIP it
  // (`if (!c) continue`) rather than crash or count it — the surviving budgets still total.
  it('[G5] a budget for a deleted category is skipped, not counted, no crash', () => {
    const totals = selectBudgetedTotals([b('salary', 5000), b('ghost', 999), b('coffee', 400)], category);
    expect(totals).toEqual({ budgetedEarned: 5000, budgetedSpent: 400 }); // ghost dropped
  });

  // [G6] target<=0 rollups are dropped by selectBudgets BEFORE they reach budgetViews, so a
  // zero/negative income "budget" never nudges budgetedEarned. Confirms the real pipeline
  // (selectBudgets → selectBudgetedTotals) the hook runs, not just the selector in isolation.
  it('[G6] selectBudgets drops target<=0 rows so they never reach budgetedEarned/Spent', () => {
    const rollups: Record<string, BudgetRollup> = {
      salary: { target: 5000, posted: 0, pending: 0 },
      lapsed: { target: 0, posted: 0, pending: 0 },      // an income floor set back to 0
      overdrawn: { target: -100, posted: 0, pending: 0 },
      coffee: { target: 400, posted: 0, pending: 0 },
    };
    const catsPlus = (id: string) =>
      id === 'lapsed' || id === 'overdrawn'
        ? { id, name: id, icon: 'cash', color: '#2ac3de', bucket: 'Income' as const, recent: 0 }
        : category(id);
    const budgets = selectBudgets(rollups);
    expect(budgets.map((x) => x.id).sort()).toEqual(['coffee', 'salary']); // <=0 filtered out
    expect(selectBudgetedTotals(budgets, catsPlus)).toEqual({ budgetedEarned: 5000, budgetedSpent: 400 });
  });
});
