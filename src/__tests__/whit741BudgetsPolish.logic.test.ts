// WHIT-741 — Budgets polish: "$X of $Y" has no "·" (pending is just counted in, WHIT-744), the "of" amount shows exact
// cents and keeps its sign, a minus never wraps away from its "$" (word joiner U+2060), "of" never
// wraps away from its amount (no-break space U+00A0), and a fully used budget hides its tick.
import { describe, it, expect } from '@jest/globals';
import { fmtSignedExact } from '../theme';
import { budgetRowFor, budgetDetailFor } from './support/budgetsTab';

const NBSP = ' ';
const SIGN = '−⁠'; // real minus + word joiner
const asSpaces = (s: string) => s.replace(/ /g, ' ');
// $40.96 target − $700 payback slice → this cycle's budget is −$659.04.
const payback = { budget: 40.96, posted: 617.75, pending: 0, spreadAdjustment: -700, spread: { amount: 2100, cycles: 3, index: 1, adjustment: -700 } };

describe('a budget row reads "$X of $Y" with pending counted in (WHIT-741, WHIT-744)', () => {
  it('with pending: "$50 of $100", no "·"', () => {
    const row = budgetRowFor({ budget: 100, posted: 40, pending: 10 });
    expect(asSpaces(row.spentLabel)).toBe('$50 of $100');
    expect(row.spentLabel).not.toContain('·');
  });
});

describe('the "of" amount shows cents and keeps its sign (WHIT-741)', () => {
  it('nothing spent of $140.67 reads "$0 of $140.67", with a no-break space after "of"', () => {
    expect(budgetRowFor({ budget: 140.67, posted: 0, pending: 0 }).spentLabel).toMatch(/^\$0[  ]of \$140\.67$/);
  });

  it('a payback cycle reads "$617.75 of −$659.04"', () => {
    const row = budgetRowFor(payback);
    expect(row.spentLabel.endsWith(`of${NBSP}${SIGN}$659.04`)).toBe(true);
    expect(asSpaces(row.spentLabel).startsWith('$617.75 of')).toBe(true);
  });

  it('the detail screen reads "of −$659.04" with the same spacing', () => {
    expect(budgetDetailFor(payback).ofBudget).toBe(`of${NBSP}${SIGN}$659.04`);
  });
});

describe('fmtSignedExact keeps the minus with its number (WHIT-741)', () => {
  it('puts a word joiner between the minus and "$"', () => {
    expect(fmtSignedExact(-659.04)).toBe('−⁠$659.04');
    expect(fmtSignedExact(659.04)).toBe('$659.04');
    expect(fmtSignedExact(-0.004)).toBe('$0');
  });
});

describe('a fully used budget hides its tick (WHIT-741)', () => {
  it('row: tick only while something is left', () => {
    expect(budgetRowFor({ budget: 100, posted: 30, pending: 0 }).showTarget).toBe(true);
    expect(budgetRowFor({ budget: 100, posted: 100, pending: 0 }).showTarget).toBe(false);
    expect(budgetRowFor({ budget: 100, posted: 150, pending: 0 }).showTarget).toBe(false);
  });

  it('detail: tick only while something is left', () => {
    expect(budgetDetailFor({ budget: 100, posted: 30 }).showTarget).toBe(true);
    expect(budgetDetailFor({ budget: 100, posted: 100 }).showTarget).toBe(false);
    expect(budgetDetailFor({ budget: 100, posted: 150 }).showTarget).toBe(false);
  });
});
