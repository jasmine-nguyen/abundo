// WHIT-712 QA — the pace deadband edges now that "on pace" is silent: exactly ±$0.50 off pace
// stays quiet, a cent past it speaks; and an overspend in cents is said once, exactly.
import { describe, it, expect } from '@jest/globals';
import { C } from '../theme';
import { budgetRowFor as rowFor } from './support/budgetsTab';

describe('pace deadband edges (WHIT-712)', () => {
  // [A1] (P0) exactly $0.50 either side of pace is still "on pace" → no line.
  it('[A1] exactly ±$0.50 off pace → no pace line', () => {
    expect(rowFor({ budget: 100, posted: 50.5, pending: 0 }).paceLabel).toBe('');
    expect(rowFor({ budget: 100, posted: 49.5, pending: 0 }).paceLabel).toBe('');
  });

  // [A2] (P0) a cent past the deadband speaks, in muted ink. "Over plan" also needs little room
  // left per day (WHIT-732), so that side uses a borrowed $55 envelope.
  it('[A2] a cent past ±$0.50 → over plan / under plan, both muted', () => {
    const behind = rowFor({ budget: 100, posted: 50.51, pending: 0, rollover: true, carryover: -45 });
    expect(behind.paceLabel).toMatch(/ over plan$/);
    expect(behind.paceColor).toBe(C.textInfo);
    const ahead = rowFor({ budget: 100, posted: 49.49, pending: 0 });
    expect(ahead.paceLabel).toMatch(/ under plan$/);
    expect(ahead.paceColor).toBe(C.textDim);
  });

  // [A3] (P1) spent exactly the budget is NOT over: amount "left", line is the behind-pace warning.
  it('[A3] spent exactly the budget → not over, $0 left, behind-pace line', () => {
    const row = rowFor({ budget: 100, posted: 100, pending: 0 });
    expect(row.over).toBe(false);
    expect(row.remainAmount).toBe('$0');
    expect(row.remainLabel).toBe('left');
    expect(row.paceLabel).toBe('$50 over plan');
  });

  // [A4] (P1) a cents overspend with no spread: the exact amount once, on the red amount only.
  it('[A4] over by $20.40 (rollover, no spread) → "$20.40" once, the pace slot only links to see why', () => {
    const row = rowFor({ budget: 100, posted: 120.4, pending: 0, rollover: true, carryover: 0 });
    expect(row.remainAmount).toBe('$20.40');
    expect(row.remainColor).toBe(C.bad);
    expect(row.paceLabel).toBe('See what happened →'); // WHIT-733
    expect(row.spentLabel).toBe('$120.40 of $100');
  });
});
