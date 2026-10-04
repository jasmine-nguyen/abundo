// WHIT-715 — budget status words say clearly whether it's good or bad: spending is "ahead of
// pace" (good) / "behind pace" (warning), income is "above target" ("over" is spending-only),
// and the detail carry-over line says "left over from" / "short from" past cycles.
import { describe, it, expect } from '@jest/globals';
import { budgetViews } from '../context';
import { C } from '../theme';
import { makeState, cat, budget } from './factory';
import { budgetRowFor as rowFor, budgetDetailFor, rowText } from './support/budgetsTab';

const halfway = { cycleLen: 14, daysLeft: 7 }; // pace target = half the budget

const incomeRow = (b: object) =>
  budgetViews(makeState({
    categories: [cat({ id: 'salary', name: 'Salary', bucket: 'Income' })],
    budgets: [budget({ id: 'salary', pending: 0, ...b })],
    ...halfway,
  })).rows[0];

const spendDetail = (b: object) => budgetDetailFor(b);

describe('budget status words say good or bad plainly (WHIT-715)', () => {
  it('spending rows read "ahead of pace" (muted) when under and "behind pace" (amber) when over', () => {
    const ahead = rowFor({ budget: 100, posted: 30, pending: 0 });
    expect(ahead.paceLabel).toBe('$20 ahead of pace');
    expect(ahead.paceColor).toBe(C.textInfo);
    const behind = rowFor({ budget: 100, posted: 70, pending: 0 });
    expect(behind.paceLabel).toBe('$20 behind pace');
    expect(behind.paceColor).toBe(C.warn);
    for (const row of [ahead, behind]) expect(row.paceLabel).not.toMatch(/over pace|under pace/);
  });

  it('a met income target reads "above target", and no income row field says "over"', () => {
    const met = incomeRow({ budget: 100, posted: 120 });
    expect(met.remainLabel).toBe('above target');
    expect(rowText(met)).not.toMatch(/\bover\b/i);
    expect(incomeRow({ budget: 100, posted: 40 }).remainLabel).toBe('to go');
  });

  it('a budget spent faster than planned reads "behind pace" on the row and in detail', () => {
    const b = { budget: 100, posted: 70 };
    expect(rowFor({ ...b, pending: 0 }).paceLabel).toBe('$20 behind pace');
    const d = spendDetail(b);
    expect(d.statusLabel).toBe('Behind pace — ease up');
    expect(d.statusColor).toBe(C.warn);
  });

  it('the detail carry-over line says left over from / short from past cycles', () => {
    expect(spendDetail({ budget: 100, posted: 10, rollover: true, carryover: 40 }).carryoverLine)
      .toBe('+$40 left over from past cycles');
    expect(spendDetail({ budget: 100, posted: 10, rollover: true, carryover: -20 }).carryoverLine)
      .toBe('$20 short from past cycles');
  });
});
