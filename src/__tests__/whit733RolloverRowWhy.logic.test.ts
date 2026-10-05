// WHIT-733 — a rollover row names how much it carries from past cycles, and the budget's own
// screen uses the same sentence. An over-budget rollover row (it can't be spread) offers a muted
// "See what happened →" link instead.
import { describe, it, expect } from '@jest/globals';
import { C } from '../theme';
import { budgetRowFor, budgetDetailFor } from './support/budgetsTab';

const seeWhyOf = (row: object) => (row as { seeWhy?: boolean }).seeWhy;

describe('rollover rows say how much and offer a way to see why (WHIT-733)', () => {
  it('Utilities over budget from past overspend: amount in the note, link to see why, same words on detail', () => {
    const utilities = { budget: 200, posted: 617.75, pending: 0, rollover: true, carryover: -859 };
    const row = budgetRowFor(utilities);
    expect(row.note).toBe('Includes $859 past overspend');
    expect(row.paceLabel).toBe('See what happened →');
    expect(row.paceColor).toBe(C.textDim);
    expect(seeWhyOf(row)).toBe(true);
    expect(row.spreadPrefill).toBeNull();
    expect(budgetDetailFor(utilities).carryoverLine).toBe('Includes $859 past overspend');
  });

  it('a rollover with leftovers under budget: amount in the note, no link, same words on detail', () => {
    const leftovers = { budget: 100, posted: 50, pending: 0, rollover: true, carryover: 40 };
    const row = budgetRowFor(leftovers);
    expect(row.note).toBe('Includes $40 past leftovers');
    expect(seeWhyOf(row)).toBe(false);
    expect(row.paceLabel).not.toBe('See what happened →');
    expect(budgetDetailFor(leftovers).carryoverLine).toBe('Includes $40 past leftovers');
  });

  it('a non-rollover over-budget row keeps its spread link and no see-why link', () => {
    const row = budgetRowFor({ budget: 100, posted: 150, pending: 0 });
    expect(seeWhyOf(row)).toBe(false);
    expect(row.spreadPrefill).not.toBeNull();
    expect(row.paceLabel).not.toBe('See what happened →');
  });
});
