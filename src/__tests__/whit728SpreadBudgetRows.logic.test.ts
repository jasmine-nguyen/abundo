// WHIT-728 — a spread bill's payback can make this cycle's budget negative. The row and the
// detail screen must keep the minus ("of −$659", real minus U+2212), and the row notes the
// spread with a muted "Includes spread bills". Maths, totals and the "over" label unchanged.
import { describe, it, expect } from '@jest/globals';
import { MINUS } from '../theme';
import { cat, budget } from './factory';
import { budgetRowFor, budgetRowsFor, budgetDetailFor } from './support/budgetsTab';

const plan = (over = {}) => ({ amount: 2100, cycles: 3, index: 1, adjustment: -700, ...over });
// $41 target − $700 payback slice → this cycle's budget is −$659.
const payback = { budget: 41, posted: 617.75, pending: 0, spreadAdjustment: -700, spread: plan() };

describe('budget rows keep the minus on a negative budget (WHIT-728)', () => {
  it('a payback cycle reads "$617.75 of −$659" and notes the spread', () => {
    const row = budgetRowFor(payback);
    expect(row.spentLabel).toBe(`$617.75 of\u00a0${MINUS}$659`);
    expect(row.note).toBe('Includes spread bills');
    expect(row.remainLabel).toBe('over');
    expect(row.remainAmount).toBe('$1,276.75');
  });

  it('a cushion (positive adjustment) has no minus but still notes the spread', () => {
    const row = budgetRowFor({ budget: 100, posted: 50, pending: 0, spreadAdjustment: 200, spread: plan({ index: 0, adjustment: 200 }) });
    expect(row.spentLabel).not.toContain(MINUS);
    expect(row.spentLabel).toBe('$50 of\u00a0$300');
    expect(row.note).toBe('Includes spread bills');
  });

  it('no spread → no note, label unchanged', () => {
    const row = budgetRowFor({ budget: 100, posted: 50, pending: 0 });
    expect(row.note).toBe('');
    expect(row.spentLabel).toBe('$50 of\u00a0$100');
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
    expect(budgetDetailFor(payback).ofBudget).toBe(`of\u00a0${MINUS}$659`);
  });
});
