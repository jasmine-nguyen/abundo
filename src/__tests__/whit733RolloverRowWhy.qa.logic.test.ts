// WHIT-733 QA — edges of the rollover note and the "See what happened →" link.
import { describe, it, expect } from '@jest/globals';
import { budgetRowFor, budgetDetailFor } from './support/budgetsTab';

const seeWhyOf = (row: object) => (row as { seeWhy?: boolean }).seeWhy;

describe('WHIT-733 rollover row edges', () => {
  // [A1]
  it('a rollover overspent this cycle despite past leftovers still gets the link and the leftovers note', () => {
    const b = { budget: 100, posted: 200, pending: 0, rollover: true, carryover: 40 };
    const row = budgetRowFor(b);
    expect(row.over).toBe(true);
    expect(seeWhyOf(row)).toBe(true);
    expect(row.paceLabel).toBe('See what happened →');
    expect(row.note).toBe('Includes $40 past leftovers');
    expect(budgetDetailFor(b).carryoverLine).toBe(row.note);
  });

  // [A2]
  it('a rollover with past overspend but still under budget shows the amount and no link', () => {
    const b = { budget: 200, posted: 20, pending: 0, rollover: true, carryover: -50 };
    const row = budgetRowFor(b);
    expect(row.over).toBe(false);
    expect(seeWhyOf(row)).toBe(false);
    expect(row.paceLabel).not.toBe('See what happened →');
    expect(row.note).toBe('Includes $50 past overspend');
    expect(budgetDetailFor(b).carryoverLine).toBe(row.note);
  });

  // [A3]
  it('a near-zero carryover gives no note on either screen, but an over rollover row still links', () => {
    const b = { budget: 100, posted: 150, pending: 0, rollover: true, carryover: -0.4 };
    const row = budgetRowFor(b);
    expect(row.note).toBe('');
    expect(budgetDetailFor(b).carryoverLine).toBe('');
    expect(seeWhyOf(row)).toBe(true);
  });

  // [A4]
  it('a non-rollover budget with a stray carryover gets no note and no link', () => {
    const row = budgetRowFor({ budget: 100, posted: 150, pending: 0, rollover: false, carryover: -300 });
    expect(row.note).toBe('');
    expect(seeWhyOf(row)).toBe(false);
  });
});
