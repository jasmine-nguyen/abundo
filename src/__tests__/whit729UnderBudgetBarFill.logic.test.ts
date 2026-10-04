// WHIT-729 — under-budget (and income) bars use one calm shared fill (soft Tokyo blue,
// C.accentSoft), never the category colour: a red/pink category bar read as "over". Over stays
// rose (C.bad). The category colour stays on the icon chip.
import { describe, it, expect } from '@jest/globals';
import { C, tint } from '../theme';
import { budgetDetailFor, budgetRowFor } from './support/budgetsTab';
import { cat } from './factory';
import { SALARY } from './support/categories';

const PINK = '#f7768e';
const pinkSpend = cat({ color: PINK });
const pinkIncome = { ...SALARY, color: PINK };

describe('budgetViews rows', () => {
  it('under-budget spend bar uses the shared fill, not the category colour', () => {
    const row = budgetRowFor({ budget: 100, posted: 20, pending: 10 }, pinkSpend);
    expect(row.over).toBe(false);
    expect(row.postedColor).toBe(C.accentSoft);
    expect(row.pendingTint).toBe(tint(C.accentSoft, 0.45));
    expect(row.color).toBe(PINK);
    expect(row.chipBg).toBe(tint(PINK, 0.15));
  });

  it('over-budget spend bar stays rose', () => {
    const row = budgetRowFor({ budget: 100, posted: 120, pending: 0 }, pinkSpend);
    expect(row.over).toBe(true);
    expect(row.postedColor).toBe(C.bad);
    expect(row.pendingTint).toBe(tint(C.bad, 0.45));
  });

  it('income bar uses the shared fill, not the category colour', () => {
    const row = budgetRowFor({ budget: 5000, posted: 1000, pending: 200 }, pinkIncome);
    expect(row.postedColor).toBe(C.accentSoft);
    expect(row.pendingTint).toBe(tint(C.accentSoft, 0.45));
    expect(row.color).toBe(PINK);
  });
});

describe('budgetDetail', () => {
  it('under-budget spend detail bar uses the shared fill', () => {
    const d = budgetDetailFor({ budget: 100, posted: 20 }, undefined, pinkSpend);
    expect(d.postedColor).toBe(C.accentSoft);
    expect(d.pendingTint).toBe(tint(C.accentSoft, 0.45));
  });

  it('over-budget spend detail bar stays rose', () => {
    const d = budgetDetailFor({ budget: 100, posted: 150 }, undefined, pinkSpend);
    expect(d.postedColor).toBe(C.bad);
  });

  it('income detail bar uses the shared fill', () => {
    const d = budgetDetailFor({ budget: 5000, posted: 1000 }, undefined, pinkIncome);
    expect(d.postedColor).toBe(C.accentSoft);
    expect(d.pendingTint).toBe(tint(C.accentSoft, 0.45));
  });
});
