// WHIT-733 — a rollover row names how much it carries from past cycles, and the budget's own
// screen uses the same sentence.
import { describe, it, expect } from '@jest/globals';
import { budgetRowFor, budgetDetailFor } from './support/budgetsTab';

describe('rollover rows say how much (WHIT-733)', () => {
  it('Utilities over budget from past overspend: amount in the note, same words on detail', () => {
    const utilities = { budget: 200, posted: 617.75, pending: 0, rollover: true, carryover: -859 };
    const row = budgetRowFor(utilities);
    expect(row.note).toBe('Includes $859 past overspend');
    expect(budgetDetailFor(utilities).carryoverLine).toBe('Includes $859 past overspend');
  });

  it('a rollover with leftovers under budget: amount in the note, same words on detail', () => {
    const leftovers = { budget: 100, posted: 50, pending: 0, rollover: true, carryover: 40 };
    const row = budgetRowFor(leftovers);
    expect(row.note).toBe('Includes $40 past leftovers');
    expect(budgetDetailFor(leftovers).carryoverLine).toBe('Includes $40 past leftovers');
  });
});
