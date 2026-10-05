// WHIT-750 QA — row-only pace cases removed with the row flag, re-pinned at the detail screen.
import { describe, it, expect } from '@jest/globals';
import { budgetDetailFor } from './support/budgetsTab';

describe('detail pace words for cases the row flag used to cover (WHIT-750 QA)', () => {
  // [A1] (P0) exactly on pace ($50 of $100, halfway) → calm, both with and without pending.
  it('[A1] exactly on the pace line stays calm', () => {
    expect(budgetDetailFor({ budget: 100, posted: 50 }).statusLabel).toBe('On track for payday');
    expect(budgetDetailFor({ budget: 100, posted: 40, pending: 10 }).statusLabel).toBe('On track for payday');
  });

  // [A3] (P1) over budget → the "over budget" words, never "over plan".
  it('[A3] over budget says over budget, not over plan', () => {
    expect(budgetDetailFor({ budget: 100, posted: 130 }).statusLabel).toBe('Over budget — ease up');
  });
});
