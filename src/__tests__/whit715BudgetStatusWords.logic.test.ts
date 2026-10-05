// WHIT-715 — budget status words say clearly whether it's good or bad: a budget too far
// ahead of pace reads "over plan" in detail, income is "above target" ("over" is spending-only),
// and the detail carry-over line says "Includes $X past leftovers" / "past overspend" (WHIT-733).
import { describe, it, expect } from '@jest/globals';
import { C } from '../theme';
import { budgetRowFor as rowFor, budgetDetailFor as spendDetail, rowText } from './support/budgetsTab';
import { SALARY } from './support/categories';

const incomeRow = (b: object) => rowFor({ pending: 0, ...b }, SALARY);

describe('budget status words say good or bad plainly (WHIT-715)', () => {
  it('a met income target reads "above target", and no income row field says "over"', () => {
    const met = incomeRow({ budget: 100, posted: 120 });
    expect(met.remainLabel).toBe('above target');
    expect(rowText(met)).not.toMatch(/\bover\b/i);
    expect(incomeRow({ budget: 100, posted: 40 }).remainLabel).toBe('to go');
  });

  it('a budget spent faster than planned reads "over plan" in detail', () => {
    const d = spendDetail({ budget: 100, posted: 85 });
    expect(d.statusLabel).toBe('Over plan — ease up');
    expect(d.statusColor).toBe(C.textInfo);
  });

  it('the detail carry-over line says past leftovers / past overspend', () => {
    expect(spendDetail({ budget: 100, posted: 10, rollover: true, carryover: 40 }).carryoverLine)
      .toBe('Includes $40 past leftovers');
    expect(spendDetail({ budget: 100, posted: 10, rollover: true, carryover: -20 }).carryoverLine)
      .toBe('Includes $20 past overspend');
  });
});
