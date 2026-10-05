// WHIT-712 QA — the pace deadband edges now that "on pace" is silent: exactly ±$0.50 off pace
// stays calm on the detail screen; and an overspend in cents is said once, exactly, on the row.
import { describe, it, expect } from '@jest/globals';
import { C } from '../theme';
import { budgetRowFor as rowFor, budgetDetailFor as detailFor } from './support/budgetsTab';

describe('pace deadband edges (WHIT-712)', () => {
  // [A1] (P0) exactly $0.50 either side of pace is still "on pace" → no warning.
  it('[A1] exactly ±$0.50 off pace → on track', () => {
    expect(detailFor({ budget: 100, posted: 50.5 }).statusLabel).toBe('On track for payday');
    expect(detailFor({ budget: 100, posted: 49.5 }).statusLabel).toBe('On track for payday');
  });

  // [A3] (P1) spent exactly the budget is NOT over: amount "left", and over plan in detail.
  it('[A3] spent exactly the budget → not over, $0 left, over plan', () => {
    const row = rowFor({ budget: 100, posted: 100, pending: 0 });
    expect(row.over).toBe(false);
    expect(row.remainAmount).toBe('$0');
    expect(row.remainLabel).toBe('left');
    expect(detailFor({ budget: 100, posted: 100 }).statusLabel).toBe('Over plan — ease up');
  });

  // [A4] (P1) a cents overspend with no spread: the exact amount once, on the red amount only.
  it('[A4] over by $20.40 (rollover, no spread) → "$20.40" once', () => {
    const row = rowFor({ budget: 100, posted: 120.4, pending: 0, rollover: true, carryover: 0 });
    expect(row.remainAmount).toBe('$20.40');
    expect(row.remainColor).toBe(C.bad);
    expect(row.spentLabel).toBe('$120.40 of $100');
  });
});
