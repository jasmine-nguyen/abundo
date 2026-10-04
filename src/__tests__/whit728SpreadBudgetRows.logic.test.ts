// WHIT-728 — a spread bill's payback can make this cycle's budget negative. The row and the
// detail screen must keep the minus ("of −$659", real minus U+2212), and the row notes the
// spread with a muted "Includes spread bills". Maths, totals and the "over" label unchanged.
import { describe, it, expect } from '@jest/globals';
import * as theme from '../theme';
import { cat, budget } from './factory';
import { budgetRowFor, budgetRowsFor, budgetDetailFor } from './support/budgetsTab';

const MINUS = '−';
const plan = (over = {}) => ({ amount: 2100, cycles: 3, index: 1, adjustment: -700, ...over });
// $41 target − $700 payback slice → this cycle's budget is −$659.
const payback = { budget: 41, posted: 617.75, pending: 0, spreadAdjustment: -700, spread: plan() };
const fmtSigned = (n: number) => (theme as unknown as { fmtSigned: (n: number) => string }).fmtSigned(n);

describe('budget rows keep the minus on a negative budget (WHIT-728)', () => {
  it('a payback cycle reads "$617.75 of −$659" and notes the spread', () => {
    const row = budgetRowFor(payback);
    expect(row.spentLabel).toMatch(/^\$617\.75 of −\$659(?![\d,])/);
    expect(row.note).toBe('Includes spread bills');
    expect(row.remainLabel).toBe('over');
    expect(row.remainAmount).toBe('$1,276.75');
  });

  it('a cushion (positive adjustment) has no minus but still notes the spread', () => {
    const row = budgetRowFor({ budget: 100, posted: 50, pending: 0, spreadAdjustment: 200, spread: plan({ index: 0, adjustment: 200 }) });
    expect(row.spentLabel).not.toContain(MINUS);
    expect(row.spentLabel).toMatch(/^\$50 of \$300(?![\d,])/);
    expect(row.note).toBe('Includes spread bills');
  });

  it('no spread → no note, label unchanged', () => {
    const row = budgetRowFor({ budget: 100, posted: 50, pending: 0 });
    expect(row.note).toBe('');
    expect(row.spentLabel).toMatch(/^\$50 of \$100(?![\d,])/);
  });

  it('spread set but adjustment 0 → no note', () => {
    const row = budgetRowFor({ budget: 100, posted: 50, pending: 0, spreadAdjustment: 0, spread: plan({ adjustment: 0 }) });
    expect(row.note).toBe('');
  });

  it('an Income row has an empty note', () => {
    const salary = cat({ id: 'salary', name: 'Salary', bucket: 'Income' });
    const row = budgetRowsFor([salary], [budget({ id: 'salary', budget: 5000, posted: 2500, pending: 0 })])[0];
    expect(row.note).toBe('');
  });

  it('the detail screen reads "of −$659"', () => {
    expect(budgetDetailFor(payback).ofBudget).toBe(`of ${MINUS}$659`);
  });
});

describe('fmtSigned (WHIT-728)', () => {
  it('signs whole dollars with a real minus and never shows −$0', () => {
    expect(fmtSigned(-659)).toBe(`${MINUS}$659`);
    expect(fmtSigned(659)).toBe('$659');
    expect(fmtSigned(0)).toBe('$0');
    expect(fmtSigned(-0.4)).toBe('$0');
    expect(fmtSigned(-0.6)).toBe(`${MINUS}$1`);
  });
});
