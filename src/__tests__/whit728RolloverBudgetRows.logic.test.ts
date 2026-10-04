// WHIT-728 follow-up — a rollover budget pulled down by a carried-over deficit reads
// "$617.75 of −$659" and must say why with a muted "Includes past overspend" (a positive
// carryover → "Includes past leftovers"). Maths, totals and the "over" label unchanged.
import { describe, it, expect } from '@jest/globals';
import { budgetRowFor } from './support/budgetsTab';

const noteOf = (row: object) => (row as { note?: string }).note;

describe('rollover budget rows explain their carryover (WHIT-728)', () => {
  it('Utilities: $200 target, carryover −859 → "of −$659" + "Includes past overspend"', () => {
    const row = budgetRowFor({ budget: 200, posted: 617.75, pending: 0, rollover: true, carryover: -859 });
    expect(row.spentLabel).toMatch(/^\$617\.75 of −\$659(?![\d,])/);
    expect(noteOf(row)).toBe('Includes past overspend');
    expect(row.remainLabel).toBe('over');
    expect(row.remainAmount).toBe('$1,276.75');
  });

  it('a positive carryover → "Includes past leftovers", label unchanged', () => {
    const row = budgetRowFor({ budget: 100, posted: 50, pending: 0, rollover: true, carryover: 40 });
    expect(row.spentLabel).toMatch(/^\$50 of \$140(?![\d,])/);
    expect(noteOf(row)).toBe('Includes past leftovers');
  });

  it.each([0.3, -0.3])('a tiny carryover (%p) → no note', (carryover) => {
    const row = budgetRowFor({ budget: 100, posted: 50, pending: 0, rollover: true, carryover });
    expect(noteOf(row)).toBe('');
  });

  it('rollover off with a stale carryover → no note', () => {
    const row = budgetRowFor({ budget: 100, posted: 50, pending: 0, rollover: false, carryover: -500 });
    expect(noteOf(row)).toBe('');
  });

  it('a spread row still says "Includes spread bills"', () => {
    const spread = { amount: 2100, cycles: 3, index: 1, adjustment: -700 };
    const row = budgetRowFor({ budget: 41, posted: 617.75, pending: 0, spreadAdjustment: -700, spread });
    expect(noteOf(row)).toBe('Includes spread bills');
  });
});
