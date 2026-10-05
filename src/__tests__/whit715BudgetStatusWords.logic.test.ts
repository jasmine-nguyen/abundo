// WHIT-715 — budget status words say clearly whether it's good or bad: a spending row too far
// ahead of pace is flagged ("over plan" in detail), income is "above target" ("over" is spending-only),
// and the detail carry-over line says "Includes $X past leftovers" / "past overspend" (WHIT-733).
import { describe, it, expect } from '@jest/globals';
import { C } from '../theme';
import { budgetRowFor as rowFor, budgetDetailFor as spendDetail, rowText } from './support/budgetsTab';
import { SALARY } from './support/categories';

const incomeRow = (b: object) => rowFor({ pending: 0, ...b }, SALARY);

describe('budget status words say good or bad plainly (WHIT-715)', () => {
  it('spending rows are flagged when over plan, and not when under', () => {
    const ahead = rowFor({ budget: 100, posted: 30, pending: 0 });
    expect(ahead.behindPace).toBe(false);
    const behind = rowFor({ budget: 100, posted: 85, pending: 0 });
    expect(behind.behindPace).toBe(true);
  });

  it('a met income target reads "above target", and no income row field says "over"', () => {
    const met = incomeRow({ budget: 100, posted: 120 });
    expect(met.remainLabel).toBe('above target');
    expect(rowText(met)).not.toMatch(/\bover\b/i);
    expect(incomeRow({ budget: 100, posted: 40 }).remainLabel).toBe('to go');
  });

  it('a budget spent faster than planned is flagged on the row and reads "over plan" in detail', () => {
    const b = { budget: 100, posted: 85 };
    expect(rowFor({ ...b, pending: 0 }).behindPace).toBe(true);
    const d = spendDetail(b);
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
