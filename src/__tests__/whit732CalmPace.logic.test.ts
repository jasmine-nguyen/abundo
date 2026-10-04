// WHIT-732 — calmer pace line on budget rows: "over plan" only shows when the user really needs
// to slow down (ahead of pace AND the daily room left is under half the daily plan), in muted
// ink, never amber. The today tick sits on the base pace target the words use, even when the bar
// is scaled to a rollover/spread envelope. Halfway through a 14-day cycle: $100 budget → $50 pace.
import { describe, it, expect } from '@jest/globals';
import { C } from '../theme';
import { urgentFirst } from '../budgetOrder';
import { budgetRowFor as rowFor, budgetDetailFor as detailFor, budgetRowsFor, rowIds } from './support/budgetsTab';
import { budget } from './factory';
import { COFFEE, GROCERIES } from './support/categories';

describe('budget rows: calm pace line and a tick that matches it (WHIT-732)', () => {
  it('a row only slightly ahead of pace with plenty left says nothing', () => {
    // $70 of $100 at halfway: $20 ahead, but $30 over 7 days ($4.29/day) is above half the daily plan ($3.57).
    const row = rowFor({ budget: 100, posted: 70, pending: 0 });
    expect(row.paceLabel).toBe('');
    expect(row.behindPace).toBe(false);
  });

  it('a row that clearly needs slowing down says "$X over plan" in muted ink', () => {
    // $85 of $100 at halfway: $15 over 7 days ($2.14/day) is under half the daily plan ($3.57).
    const row = rowFor({ budget: 100, posted: 85, pending: 0 });
    expect(row.paceLabel).toBe('$35 over plan');
    expect(row.paceColor).toBe(C.textInfo);
    expect(row.behindPace).toBe(true);
  });

  it('the "under plan" line stays, muted', () => {
    const row = rowFor({ budget: 100, posted: 30, pending: 0 });
    expect(row.paceLabel).toBe('$20 under plan');
    expect(row.paceColor).toBe(C.textDim);
  });

  it('the tick sits on the base pace target, on a bar scaled to the envelope', () => {
    // No rollover: envelope == budget, tick unchanged at elapsed.
    expect(rowFor({ budget: 100, posted: 30, pending: 0 }).targetPct).toBe(50);
    // Rollover leftovers: $200 envelope, $50 pace → a quarter along the bar.
    const leftovers = rowFor({ budget: 100, posted: 30, pending: 0, rollover: true, carryover: 100 });
    expect(leftovers.paceLabel).toBe('$20 under plan');
    expect(leftovers.targetPct).toBe(25);
    // Past overspend: $70 envelope, $50 pace → right of halfway.
    expect(rowFor({ budget: 100, posted: 10, pending: 0, rollover: true, carryover: -30 }).targetPct).toBe(71);
    // Past overspend bigger than the pace: $40 envelope, $50 pace → capped at the end of the bar.
    expect(rowFor({ budget: 100, posted: 10, pending: 0, rollover: true, carryover: -60 }).targetPct).toBe(100);
    // Drained envelope: the bar falls back to the base budget, so the tick is at elapsed.
    expect(rowFor({ budget: 100, posted: 0, pending: 0, rollover: true, carryover: -100 }).targetPct).toBe(50);
    // Spread cushion: $160 envelope, $50 pace.
    const cushion = rowFor({ budget: 100, posted: 30, pending: 0, spreadAdjustment: 60, spread: { amount: 120, cycles: 2, index: 1, adjustment: 60 } });
    expect(cushion.targetPct).toBe(31);
  });

  it('urgent-first order no longer lifts a row that is only slightly ahead', () => {
    const rows = budgetRowsFor([COFFEE, GROCERIES], [
      budget({ id: 'coffee', budget: 100, posted: 30, pending: 0 }),
      budget({ id: 'groceries', budget: 100, posted: 70, pending: 0 }),
    ]);
    expect(rowIds(urgentFirst(rows))).toEqual(['coffee', 'groceries']);
  });
});

describe('budget detail agrees with the row (WHIT-732)', () => {
  it('slightly ahead is not "Over plan" on the detail either', () => {
    expect(detailFor({ budget: 100, posted: 70 }).statusLabel).not.toBe('Over plan — ease up');
  });

  it('clearly needing to slow down reads "Over plan — ease up" in muted ink', () => {
    const d = detailFor({ budget: 100, posted: 85 });
    expect(d.statusLabel).toBe('Over plan — ease up');
    expect(d.statusColor).toBe(C.textInfo);
  });

  it('the detail tick matches the row tick on a rollover envelope', () => {
    expect(detailFor({ budget: 100, posted: 30, rollover: true, carryover: 100 }).targetPct).toBe(25);
    expect(detailFor({ budget: 100, posted: 30 }).targetPct).toBe(50);
  });
});
