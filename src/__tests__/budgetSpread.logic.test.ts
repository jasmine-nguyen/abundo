// Bill SPREAD (WHIT-505) — client view math. A spend category's `spread` from the server
// carries a signed `adjustment` this cycle (a + cushion in the anchor cycle, a − slice in a
// payback cycle). budgetViews/budgetDetail fold it into the spendable envelope exactly like
// rollover's carryover (the two are mutually exclusive). budgetDetail also exposes the
// entry-point gating (spreadActive / canStartSpread / overspend); budgetEditInfo greys the
// rollover toggle off while a spread is active; spreadPreview mirrors the server's cent split.
import { describe, it, expect } from '@jest/globals';
import { budgetViews, budgetDetail, budgetEditInfo, toBudget, spreadPreview, cycleName } from '../context';
import { makeState, cat, budget } from './factory';

const sink = (over = {}) => cat({ id: 'sink', name: 'Sink', bucket: 'Lifestyle', ...over });
const state = (b: object) => makeState({
  categories: [sink()], budgets: [budget({ id: 'sink', ...b })], cycleLen: 14, daysLeft: 7,
});
const detail = (b: object, category = sink()) => budgetDetail(makeState({
  categories: [category], budgets: [budget({ id: 'sink', ...b })], cycleLen: 14, daysLeft: 7,
}), 'sink')!;
const plan = (over = {}) => ({ amount: 1390.91, cycles: 4, index: 0, adjustment: 1390.91, ...over });

// ── toBudget maps + defaults ─────────────────────────────────────────────────
describe('toBudget — spread field', () => {
  it('maps a rollup with spread → spreadAdjustment + passthrough', () => {
    const b = toBudget('x', { target: 250, posted: 1390.91, pending: 0, spread: plan() });
    expect(b.spreadAdjustment).toBe(1390.91);
    expect(b.spread).toEqual(plan());
  });

  it('defaults a rollup without spread → 0 / undefined', () => {
    const b = toBudget('x', { target: 250, posted: 10, pending: 0 });
    expect(b.spreadAdjustment).toBe(0);
    expect(b.spread).toBeUndefined();
  });
});

// ── budgetViews folds the adjustment into the envelope ───────────────────────
describe('budgetViews — spread adjustment', () => {
  it('a cushion lifts the envelope and clears over budget', () => {
    // Bill of 1390.91 landed (posted) but the cushion covers it this cycle.
    const { rows, totBudget, totRemain } = budgetViews(state({
      budget: 250, posted: 1390.91, pending: 0, spreadAdjustment: 1390.91, spread: plan(),
    }));
    const row = rows[0];
    expect(row.over).toBe(false);                 // available 1640.91 > spent 1390.91
    expect(row.remainAmount).toBe('$250');        // 1640.91 - 1390.91
    // Hero totals count the cushioned envelope so the top number matches the row.
    expect(totBudget).toBe(1640.91);
    expect(totRemain).toBeCloseTo(250, 2);
  });

  it('a payback slice lowers the envelope', () => {
    const row = budgetViews(state({
      budget: 250, posted: 0, pending: 0, spreadAdjustment: -50, spread: plan({ index: 1, adjustment: -50 }),
    })).rows[0];
    expect(row.remainAmount).toBe('$200');        // available = 250 - 50
    expect(row.over).toBe(false);
  });

  it('a rollover row is unchanged (spreadAdjustment defaults 0)', () => {
    // FAIL-ON-REVERT guard: folding spreadAdjustment must not disturb a rollover envelope.
    const row = budgetViews(state({ budget: 100, posted: 0, pending: 0, rollover: true, carryover: 200 })).rows[0];
    expect(row.remainAmount).toBe('$300');
  });
});

// ── budgetDetail folds + exposes the entry-point gating ──────────────────────
describe('budgetDetail — spread', () => {
  it('a cushion flips over false yet keeps the plan reachable via spreadActive', () => {
    const d = detail({ budget: 250, posted: 1390.91, pending: 0, spreadAdjustment: 1390.91, spread: plan() });
    expect(d.ofBudget).toBe('of $1,641');         // available envelope (header rounds to whole dollars)
    expect(d.statusLabel).not.toBe('Over budget — ease up');
    expect(d.spreadActive).toBe(true);            // reachable to edit/remove even though not "over"
    expect(d.canStartSpread).toBe(false);         // already has a plan
  });

  it('an over-budget category with no plan can start a spread, prefilled with the overspend', () => {
    const d = detail({ budget: 100, posted: 130.1, pending: 0 });
    expect(d.canStartSpread).toBe(true);
    expect(d.spreadActive).toBe(false);
    expect(d.overspend).toBe(30.1);               // spent - budget, rounded to cents (no float dust)
  });

  it('does NOT offer a spread on a sub-cent overspend (would prefill an unsaveable $0)', () => {
    // FAIL-ON-REVERT for the `overspend >= 0.01` gate: over by less than a cent rounds the
    // prefill to $0, and a $0 spread can't be saved — so the button must stay hidden.
    const d = detail({ budget: 100, posted: 100.004, pending: 0 });
    expect(d.statusLabel).toBe('Over budget — ease up');   // genuinely over…
    expect(d.overspend).toBe(0);                            // …but rounds to nothing to spread
    expect(d.canStartSpread).toBe(false);
  });

  it('does NOT offer a fresh spread on a rollover category, even when over budget', () => {
    // FAIL-ON-REVERT for the !b.rollover gate: rollover XOR spread.
    const d = detail({ budget: 100, posted: 130, pending: 0, rollover: true, carryover: -50 });
    expect(d.canStartSpread).toBe(false);
  });

  it('shows the dollar effect on the status line, with a "last cycle" tag on the final slice', () => {
    const cushion = detail({ budget: 250, posted: 0, pending: 0, spreadAdjustment: 1390.91, spread: plan() });
    expect(cushion.spreadLine).toBe('Bill spread: +$1,390.91 added this cycle');
    const mid = detail({ budget: 250, posted: 0, pending: 0, spreadAdjustment: -347.73, spread: plan({ index: 1, cycles: 4, adjustment: -347.73 }) });
    expect(mid.spreadLine).toBe('Bill spread: $347.73 paid back this cycle');
    const last = detail({ budget: 250, posted: 0, pending: 0, spreadAdjustment: -347.72, spread: plan({ index: 4, cycles: 4, adjustment: -347.72 }) });
    expect(last.spreadLine).toBe('Bill spread: $347.72 paid back this cycle (last cycle)');
  });

  it('an Income earn-target carries the shared keys but never offers a spread', () => {
    const income = cat({ id: 'sink', name: 'Salary', bucket: 'Income' });
    const d = detail({ budget: 5000, posted: 6000, pending: 0 }, income);
    expect(d.canStartSpread).toBe(false);
    expect(d.overspend).toBe(0);
    expect(d.spreadActive).toBe(false);
  });
});

// ── budgetEditInfo greys the rollover toggle off under an active spread ──────
describe('budgetEditInfo — rollover vs spread', () => {
  const editInfo = (b: object) => budgetEditInfo({
    budgets: [budget({ id: 'sink', ...b })], category: (id: string) => (id === 'sink' ? sink() : undefined),
    cycleName: () => cycleName(14),
  }, 'sink');

  it('disallows rollover while a spread is active', () => {
    expect(editInfo({ spread: plan() }).rolloverAllowed).toBe(false);
    expect(editInfo({ spread: plan() }).spreadActive).toBe(true);
  });

  it('allows rollover on a plain spend budget', () => {
    expect(editInfo({}).rolloverAllowed).toBe(true);
    expect(editInfo({}).spreadActive).toBe(false);
  });
});

// ── spreadPreview mirrors the server's whole-cent split ──────────────────────
describe('spreadPreview — cent-exact slices', () => {
  it('carries the odd cent on the earliest slices (100 / 3)', () => {
    // FAIL-ON-REVERT: a naive amount/cycles would give 33.33 for both, losing a cent.
    const p = spreadPreview(100, 3);
    expect(p.cushion).toBe(100);
    expect(p.firstSlice).toBe(33.34);
    expect(p.lastSlice).toBe(33.33);
  });

  it('splits evenly when there is no remainder (100 / 4)', () => {
    const p = spreadPreview(100, 4);
    expect(p.firstSlice).toBe(25);
    expect(p.lastSlice).toBe(25);
  });

  it('matches the Insurance example (1390.91 / 4)', () => {
    const p = spreadPreview(1390.91, 4);
    expect(p.firstSlice).toBe(347.73);
    expect(p.lastSlice).toBe(347.72);
  });
});
