// WHIT-712 — budget rows stay quiet by default: one money line ("$X of $Y · $Z pending"), no
// "on pace" line, the overspend said once, and carried-over / borrowed only on the detail screen.
import { describe, it, expect } from '@jest/globals';
import { budgetViews } from '../context';
import { C } from '../theme';
import { makeState, cat, budget } from './factory';

const coffee = cat({ id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle' });
// 14-day cycle, 7 days left → halfway, so a $100 budget's pace target is $50.
const rowFor = (b: object) =>
  budgetViews(makeState({ categories: [coffee], budgets: [budget({ id: 'coffee', ...b })], cycleLen: 14, daysLeft: 7 })).rows[0];

describe('budget rows only speak up when off pace (WHIT-712)', () => {
  it('an on-pace row shows no pace line', () => {
    const row = rowFor({ budget: 100, posted: 50, pending: 0 });
    expect(row.paceLabel).toBe('');
    expect(row.remainAmount).toBe('$50');
    expect(row.remainLabel).toBe('left');
  });

  it('under pace and over pace still speak', () => {
    const under = rowFor({ budget: 100, posted: 30, pending: 0 });
    expect(under.paceLabel).toBe('$20 under pace');
    expect(under.paceColor).toBe(C.textInfo);
    const ahead = rowFor({ budget: 100, posted: 70, pending: 0 });
    expect(ahead.paceLabel).toBe('$20 over pace');
    expect(ahead.paceColor).toBe(C.warn);
  });

  it('over budget with no spread says the overspend once, in the red amount', () => {
    const row = rowFor({ budget: 100, posted: 120, pending: 0, rollover: true, carryover: 0 });
    expect(row.paceLabel).toBe('');
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

  it('no row field mentions carried over or borrowed', () => {
    for (const carryover of [200, -40]) {
      const row = rowFor({ budget: 100, posted: 0, pending: 0, rollover: true, carryover });
      const text = Object.values(row).filter((v) => typeof v === 'string').join(' | ');
      expect(text).not.toMatch(/carried over|borrowed/);
      expect(row).not.toHaveProperty('carryoverLabel');
    }
  });
});
