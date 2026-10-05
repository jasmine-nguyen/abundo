// WHIT-712 — budget rows stay quiet by default: one money line ("$X of $Y"), no
// "on pace" line, the overspend said once, and carried-over / borrowed only on the detail screen.
import { describe, it, expect } from '@jest/globals';
import { C } from '../theme';
import { budgetRowFor as rowFor, rowText } from './support/budgetsTab';

describe('budget rows are only flagged when off pace (WHIT-712)', () => {
  it('an on-pace row is not behind pace', () => {
    const row = rowFor({ budget: 100, posted: 50, pending: 0 });
    expect(row.behindPace).toBe(false);
    expect(row.remainAmount).toBe('$50');
    expect(row.remainLabel).toBe('left');
  });

  it('over plan is still flagged', () => {
    const behind = rowFor({ budget: 100, posted: 85, pending: 0 });
    expect(behind.behindPace).toBe(true);
  });

  it('over budget says the overspend once, in the red amount', () => {
    const row = rowFor({ budget: 100, posted: 120, pending: 0, rollover: true, carryover: 0 });
    expect(row.behindPace).toBe(false);
    expect(row.remainAmount).toBe('$20');
    expect(row.remainLabel).toBe('over');
    expect(row.remainColor).toBe(C.bad);
    expect(rowText(row).match(/\$20(?![\d.,])/g)).toHaveLength(1);
  });

  it('the money line reads "$X of $Y", pending included, no pending line (WHIT-744)', () => {
    const row = rowFor({ budget: 600, posted: 374, pending: 38 });
    expect(row.spentLabel).toBe('$412 of\u00a0$600');
    expect(rowFor({ budget: 100, posted: 40, pending: 0 }).spentLabel).toBe('$40 of\u00a0$100');
  });

  it('no row field mentions the carry-over', () => {
    for (const carryover of [200, -40]) {
      const row = rowFor({ budget: 100, posted: 0, pending: 0, rollover: true, carryover });
      expect(rowText(row)).not.toMatch(/carried over|borrowed|short from|left over from/);
      expect(row).not.toHaveProperty('carryoverLabel');
    }
  });
});
