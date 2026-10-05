// WHIT-733 QA — edges of the rollover note.
import { describe, it, expect } from '@jest/globals';
import { budgetRowFor, budgetDetailFor } from './support/budgetsTab';

describe('WHIT-733 rollover row edges', () => {
  // [A1]
  it('a rollover overspent this cycle despite past leftovers still gets the leftovers note', () => {
    const b = { budget: 100, posted: 200, pending: 0, rollover: true, carryover: 40 };
    const row = budgetRowFor(b);
    expect(row.over).toBe(true);
    expect(row.note).toBe('Includes $40 past leftovers');
    expect(budgetDetailFor(b).carryoverLine).toBe(row.note);
  });

  // [A2]
  it('a rollover with past overspend but still under budget shows the amount', () => {
    const b = { budget: 200, posted: 20, pending: 0, rollover: true, carryover: -50 };
    const row = budgetRowFor(b);
    expect(row.over).toBe(false);
    expect(row.note).toBe('Includes $50 past overspend');
    expect(budgetDetailFor(b).carryoverLine).toBe(row.note);
  });

  // [A3]
  it('a near-zero carryover gives no note on either screen', () => {
    const b = { budget: 100, posted: 150, pending: 0, rollover: true, carryover: -0.4 };
    const row = budgetRowFor(b);
    expect(row.note).toBe('');
    expect(budgetDetailFor(b).carryoverLine).toBe('');
  });

  // [A4]
  it('a non-rollover budget with a stray carryover gets no note', () => {
    const row = budgetRowFor({ budget: 100, posted: 150, pending: 0, rollover: false, carryover: -300 });
    expect(row.note).toBe('');
  });
});
