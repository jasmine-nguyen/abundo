// WHIT-203 GAP — budgetDetail/budgetEditInfo narrowed to BudgetDetailInput/BudgetEditInput.
// (1) A plain object satisfying ONLY the narrow input drives them (locks the narrowing —
//     reverting the param to AppContext fails `tsc --noEmit`). (2) The cold-cache path the
//     migrated budget screens rely on: an unresolved query (category→undefined / no budget)
//     returns null gracefully instead of crashing. budget.logic.test.ts only uses makeState
//     (a cast full AppContext), so neither is covered there.
import { describe, it, expect } from '@jest/globals';
import { budgetDetail, budgetEditInfo } from '../context';
import type { BudgetDetailInput, BudgetEditInput } from '../context';
import { cat, budget, txn } from './factory';

describe('budgetDetail — narrow BudgetDetailInput', () => {
  it('drives from a plain narrow object (no AppContext) for a spend budget', () => {
    const input: BudgetDetailInput = {
      category: (id: string) => (id === 'coffee' ? cat({ id: 'coffee', bucket: 'Lifestyle' }) : undefined),
      budgets: [budget({ id: 'coffee', budget: 100, posted: 40, pending: 10 })],
      transactions: [txn({ transaction_id: 'x1', category: 'coffee' })],
      cycleLen: 14,
      daysLeft: 7,
    };
    const bd = budgetDetail(input, 'coffee');
    expect(bd).not.toBeNull();
    expect(bd!.spentBig).toBe('$50');           // posted 40 + pending 10
    expect(bd!.ofBudget).toBe('of $100');
    expect(bd!.postedPct).toBe(40);
    expect(bd!.statusLabel).toBe('On target — keep it up');
    expect(bd!.statusColor).toBe('#35d9a0');
    expect(bd!.relEmpty).toBe(false);
    expect(bd!.relGroups).toHaveLength(1);
  });

  it('returns null on a cold cache (category lookup empty, no budget) — the screen shows the empty Header', () => {
    const cold: BudgetDetailInput = {
      category: () => undefined,
      budgets: [],
      transactions: [],
      cycleLen: 14,
      daysLeft: 7,
    };
    expect(budgetDetail(cold, 'coffee')).toBeNull();
  });

  it('returns null when the category exists but its budget row has not loaded yet', () => {
    const partial: BudgetDetailInput = {
      category: (id: string) => (id === 'coffee' ? cat({ id: 'coffee' }) : undefined),
      budgets: [],                 // budgets query still loading
      transactions: [],
      cycleLen: 14,
      daysLeft: 7,
    };
    expect(budgetDetail(partial, 'coffee')).toBeNull();
  });
});

describe('budgetEditInfo — narrow BudgetEditInput', () => {
  it('drives from a plain narrow object using the injected cycleName', () => {
    const input: BudgetEditInput = {
      category: (id: string) => (id === 'coffee' ? cat({ id: 'coffee', recent: 52 }) : undefined),
      budgets: [],
      cycleName: () => 'Monthly',
    };
    const info = budgetEditInfo(input, 'coffee');
    expect(info.category?.id).toBe('coffee');
    expect(info.periodLabel).toBe('MONTHLY');
    expect(info.lastWord).toBe('month');
    expect(info.hasRecommendation).toBe(true);
    expect(info.title).toBe('Set budget');
  });

  it('does not throw on a cold cache (category lookup empty)', () => {
    const cold: BudgetEditInput = {
      category: () => undefined,
      budgets: [],
      cycleName: () => 'Fortnightly',
    };
    const info = budgetEditInfo(cold, 'missing');
    expect(info.category).toBeUndefined();
    expect(info.hasRecommendation).toBe(true);   // isIncome=false when c is undefined
    expect(info.existing).toBeUndefined();
    expect(info.title).toBe('Set budget');
  });
});
