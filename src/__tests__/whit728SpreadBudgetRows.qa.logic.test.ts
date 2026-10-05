// WHIT-728 QA — the signed "of" survives pending spend, and a tiny negative budget never
// reads "of −$0".
import { describe, it, expect } from '@jest/globals';
import { MINUS } from '../theme';
import { budgetRowFor, budgetDetailFor } from './support/budgetsTab';

const plan = { amount: 2100, cycles: 3, index: 1, adjustment: -700 };

describe('signed "of" edges (WHIT-728)', () => {
  // [A3] payback cycle with pending → "of −$659" (pending counted in spent).
  it('keeps the minus when some spend is pending', () => {
    const row = budgetRowFor({ budget: 41, posted: 600, pending: 17.75, spreadAdjustment: -700, spread: plan });
    expect(row.spentLabel).toBe(`$617.75 of\u00a0${MINUS}$659`);
  });

  // [A4] a budget under a cent below zero rounds to $0 — never "−$0", on the row or the detail.
  it('a budget of −$0.003 reads "of $0", not "of −$0"', () => {
    const b = { budget: 0.997, posted: 5, pending: 0, spreadAdjustment: -1, spread: plan };
    expect(budgetRowFor(b).spentLabel).toBe('$5 of\u00a0$0');
    expect(budgetDetailFor(b).ofBudget).toBe('of\u00a0$0');
  });
});
