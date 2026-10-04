// WHIT-730 — Budgets polish. The pace line reads "$X over plan" / "$X under plan" (not the
// backwards "behind pace"), over rows drop the "today" tick, a budget with nothing spent yet is
// flagged `unspent` (drawn as a slim row), and the detail screen uses the same words and tick rule.
// Halfway through a 14-day cycle, so a $100 budget's pace target is $50.
import { describe, it, expect } from '@jest/globals';
import { SALARY } from './support/categories';
import { budgetRowFor, budgetRowsFor, budgetDetailFor } from './support/budgetsTab';
import { budget } from './factory';

type Row = ReturnType<typeof budgetRowFor> & { unspent?: boolean };
type Detail = ReturnType<typeof budgetDetailFor> & { showTarget?: boolean };

describe('Budgets rows (WHIT-730)', () => {
  it('pace words say over/under plan, over rows hide the tick, and $0 rows are unspent', () => {
    const overPlan = budgetRowFor({ budget: 100, posted: 70, pending: 0 }) as Row;
    expect(overPlan.paceLabel).toBe('$20 over plan');
    expect(overPlan.showTarget).toBe(true);
    expect(overPlan.unspent).toBe(false);

    const underPlan = budgetRowFor({ budget: 100, posted: 20, pending: 0 }) as Row;
    expect(underPlan.paceLabel).toBe('$30 under plan');
    expect(underPlan.showTarget).toBe(true);

    const overBudget = budgetRowFor({ budget: 100, posted: 130, pending: 0 }) as Row;
    expect(overBudget.showTarget).toBe(false);
    expect(overBudget.unspent).toBe(false);

    expect((budgetRowFor({ budget: 100, posted: 0, pending: 0 }) as Row).unspent).toBe(true);
    expect((budgetRowFor({ budget: 100, posted: 0.01, pending: 0 }) as Row).unspent).toBe(false);
    // $41 target − $700 spread payback → a −$659 budget: $0 spent is still over, so not slim.
    const payback = budgetRowFor({
      budget: 41, posted: 0, pending: 0, spreadAdjustment: -700,
      spread: { amount: 2100, cycles: 3, index: 1, adjustment: -700 },
    }) as Row;
    expect(payback.unspent).toBe(false);

    const income = budgetRowsFor([SALARY], [budget({ id: 'salary', budget: 5000, posted: 0, pending: 0 })])[0] as Row;
    expect(income.unspent).toBe(false);
  });

  it('the budget detail screen says "Over plan — ease up" and hides the tick when over', () => {
    const overPlan = budgetDetailFor({ budget: 100, posted: 70 }) as Detail;
    expect(overPlan.statusLabel).toBe('Over plan — ease up');
    expect(overPlan.showTarget).toBe(true);

    const overBudget = budgetDetailFor({ budget: 100, posted: 130 }) as Detail;
    expect(overBudget.statusLabel).toBe('Over budget — ease up');
    expect(overBudget.showTarget).toBe(false);
  });
});
