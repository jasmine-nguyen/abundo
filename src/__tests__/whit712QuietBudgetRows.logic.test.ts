// WHIT-712 — budget rows stay quiet by default: one money line ("$X of $Y · $Z pending"), no
// "on pace" line, the overspend said once, and carried-over / borrowed only on the detail screen.
import { describe, it, expect } from '@jest/globals';
import { C } from '../theme';
import { budgetRowFor as rowFor, rowText } from './support/budgetsTab';

describe('budget rows only speak up when off pace (WHIT-712)', () => {
  it('an on-pace row shows no pace line', () => {
    const row = rowFor({ budget: 100, posted: 50, pending: 0 });
    expect(row.paceLabel).toBe('');
    expect(row.remainAmount).toBe('$50');
    expect(row.remainLabel).toBe('left');
  });

  it('under plan and over plan still speak', () => {
    const ahead = rowFor({ budget: 100, posted: 30, pending: 0 });
    expect(ahead.paceLabel).toBe('$20 under plan');
    expect(ahead.paceColor).toBe(C.textDim);
    const behind = rowFor({ budget: 100, posted: 85, pending: 0 });
    expect(behind.paceLabel).toBe('$35 over plan');
    expect(behind.paceColor).toBe(C.textInfo);
  });

  it('over budget with no spread says the overspend once, in the red amount', () => {
    const row = rowFor({ budget: 100, posted: 120, pending: 0, rollover: true, carryover: 0 });
    expect(row.paceLabel).toBe('See what happened →'); // WHIT-733: a link, not a second amount
    expect(row.remainAmount).toBe('$20');
    expect(row.remainLabel).toBe('over');
    expect(row.remainColor).toBe(C.bad);
    expect(row.spreadPrefill).toBeNull();
    const said = [row.spentLabel, row.remainAmount, row.paceLabel].join(' | ');
    expect(said.match(/\$20(?![\d.,])/g)).toHaveLength(1);
  });

  it('over budget where a spread can start still offers the spread link', () => {
    const row = rowFor({ budget: 100, posted: 120, pending: 0 });
    expect(row.paceLabel).toBe('Spread it over pay cycles →');
    expect(row.spreadPrefill).toBe(20);
    expect(row.remainColor).toBe(C.bad);
  });

  it('the money line reads "$X of $Y · $Z pending"', () => {
    expect(rowFor({ budget: 600, posted: 374, pending: 38 }).spentLabel).toBe('$412 of $600 · $38 pending');
    expect(rowFor({ budget: 100, posted: 40, pending: 0 }).spentLabel).toBe('$40 of $100');
  });

  it('no row field mentions the carry-over', () => {
    for (const carryover of [200, -40]) {
      const row = rowFor({ budget: 100, posted: 0, pending: 0, rollover: true, carryover });
      expect(rowText(row)).not.toMatch(/carried over|borrowed|short from|left over from/);
      expect(row).not.toHaveProperty('carryoverLabel');
    }
  });
});
