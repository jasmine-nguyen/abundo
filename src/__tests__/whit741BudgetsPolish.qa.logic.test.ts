// WHIT-741 QA — edges of the Budgets polish the main tests don't pin: the tick's "fully used"
// boundary (float dust either side of a cent), pending counted in the spent line with cents, the
// earning row never naming pending, rollover "of" with cents, and the word joiner on
// large and dust-sized amounts. Calls the real budgetViews / budgetDetail / fmtSignedExact.
import { describe, it, expect } from '@jest/globals';
import { fmtSignedExact, MINUS } from '../theme';
import { budgetRowFor, budgetDetailFor } from './support/budgetsTab';
import { cat } from './factory';
import { SALARY } from './support/categories';

const NBSP = ' ';

describe('WHIT-741 QA — tick boundary', () => {
  // [A1] (P0) less than half a cent left reads "$0 left" → no tick, on the row and the detail.
  it('[A1] $0.004 left → no tick (row + detail)', () => {
    expect(budgetRowFor({ budget: 100, posted: 99.996, pending: 0 }).showTarget).toBe(false);
    expect(budgetDetailFor({ budget: 100, posted: 99.996 }).showTarget).toBe(false);
  });

  // [A2] (P0) a cent left → the tick stays (row + detail).
  it('[A2] $0.01 left → tick stays (row + detail)', () => {
    expect(budgetRowFor({ budget: 100, posted: 99.99, pending: 0 }).showTarget).toBe(true);
    expect(budgetDetailFor({ budget: 100, posted: 99.99 }).showTarget).toBe(true);
  });

  // [A3] (P0) pending counts as spent: posted + pending = the whole budget → fully used, no tick.
  it('[A3] posted + pending use the whole budget → no tick', () => {
    expect(budgetRowFor({ budget: 100, posted: 60, pending: 40 }).showTarget).toBe(false);
    expect(budgetDetailFor({ budget: 100, posted: 60, pending: 40 }).showTarget).toBe(false);
  });

  // [A4] (P1) rollover: the available envelope (target + leftovers) decides "fully used", not the target.
  it('[A4] rollover row past its target but inside its leftovers keeps the tick', () => {
    const row = budgetRowFor({ budget: 100, posted: 120, pending: 0, rollover: true, carryover: 50 });
    expect(row.showTarget).toBe(true);
    expect(row.spentLabel).toBe(`$120 of${NBSP}$150`);
  });
});

describe('WHIT-741 QA — pending counted in spent', () => {
  // [A5] (P0) pending with cents is counted in spent, with no pending words (WHIT-744).
  it('[A5] pending $39.10 → "$89.10 of $200", no pending words', () => {
    const row = budgetRowFor({ budget: 200, posted: 50, pending: 39.1 });
    expect(row.spentLabel).not.toContain('pending');
    expect(row.spentLabel).toBe(`$89.10 of${NBSP}$200`);
  });

  // [A7] (P1) an over-budget row with pending has no "·" on the spent line.
  it('[A7] over budget + pending → no "·" on the spent line', () => {
    const row = budgetRowFor({ budget: 100, posted: 100, pending: 20 });
    expect(row.over).toBe(true);
    expect(row.spentLabel).not.toContain('·');
  });

  // [A8] (P1) earning rows never name pending, even with pending money.
  it('[A8] an income row with pending has no pending words', () => {
    const row = budgetRowFor({ budget: 5000, posted: 1000, pending: 300 }, cat(SALARY));
    expect(row.section).toBe('earning');
    expect(row.spentLabel).not.toContain('pending');
  });
});

describe('WHIT-741 QA — exact signed amounts', () => {
  // [A9] (P0) the word joiner sits between the minus and "$" on thousands too.
  it('[A9] fmtSignedExact(-1234.5) → minus, word joiner, "$1,234.50"', () => {
    expect(MINUS).toBe('−⁠');
    expect(fmtSignedExact(-1234.5)).toBe('−⁠$1,234.50');
  });

  // [A10] (P1) exactly −half a cent rounds to −$0.01, which is below zero → signed.
  it('[A10] fmtSignedExact(-0.006) is signed; -0.004 is not', () => {
    expect(fmtSignedExact(-0.006)).toBe(`${MINUS}$0.01`);
    expect(fmtSignedExact(-0.004)).not.toContain('−');
  });

  // [A11] (P1) detail "of" with cents on a positive non-whole budget.
  it('[A11] detail reads "of $140.67"', () => {
    expect(budgetDetailFor({ budget: 140.67, posted: 0 }).ofBudget).toBe(`of${NBSP}$140.67`);
  });

  // [A12] (P1) the "of" amount isn't rounded half up to a whole dollar any more.
  it('[A12] $99.50 budget reads "of $99.50", not "of $100"', () => {
    expect(budgetRowFor({ budget: 99.5, posted: 10, pending: 0 }).spentLabel).toBe(`$10 of${NBSP}$99.50`);
  });
});
