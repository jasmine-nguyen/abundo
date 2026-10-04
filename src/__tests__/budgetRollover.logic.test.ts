// Budget ROLLOVER (envelope carryover) — client view math.
// budgetViews/budgetDetail spend this cycle's AVAILABLE envelope (target + buffer): a sinking
// fund adds room, a spike carries a deficit. Over-budget (red) is measured against available,
// pace stays on the base target, and the bar denominator can never divide by 0. toBudget
// defaults the fields for a non-rollover/legacy budget.
import { describe, it, expect } from '@jest/globals';
import { budgetViews } from '../context';
import { toBudget } from '../model';
import { makeState, cat, budget } from './factory';
import { budgetDetailFor } from './support/budgetsTab';

const sink = (over = {}) => cat({ id: 'sink', name: 'Sink', bucket: 'Lifestyle', ...over });
const state = (b: object) => makeState({
  categories: [sink()], budgets: [budget({ id: 'sink', ...b })],
  cycleLen: 14, daysLeft: 7, // elapsed 0.5 → base pace target = budget * 0.5
});

// ── positive buffer: unused budget accumulates ───────────────────────────────
describe('budgetViews — positive carryover (sinking fund)', () => {
  it('adds the buffer to the spendable envelope', () => {
    const { rows, totBudget, totSpent, totRemain } = budgetViews(
      state({ budget: 100, posted: 0, pending: 0, rollover: true, carryover: 200 }));
    const row = rows[0];
    expect(row.remainAmount).toBe('$300');      // available = 100 + 200
    expect(row.remainLabel).toBe('left');
    expect(row.over).toBe(false);
    expect(row.spentLabel).toBe('$0 of $300'); // "of" is the available envelope
    // Hero totals count the envelope so the top number matches the rows.
    expect([totBudget, totSpent, totRemain]).toEqual([300, 0, 300]);
  });

  it('drawing down the buffer past the base target is NOT over budget, but pace still warns', () => {
    // spent 250 > base target 100, but < available 300 → calm on the ceiling. Pace is measured
    // on the BASE target (100 * 0.5 = 50), so 250 is well over plan, and $50 over 7 days is under
    // half the $21.43 daily plan (WHIT-732), so the line shows.
    const row = budgetViews(state({ budget: 100, posted: 250, pending: 0, rollover: true, carryover: 200 })).rows[0];
    expect(row.over).toBe(false);
    expect(row.remainAmount).toBe('$50');       // 300 - 250
    expect(row.paceLabel).toContain('over plan');  // pace stays on the base target
  });
});

// ── negative buffer: overspend carries as a deficit ──────────────────────────
describe('budgetViews — negative carryover (borrow)', () => {
  it('a deficit lowers the envelope', () => {
    const row = budgetViews(state({ budget: 100, posted: 0, pending: 0, rollover: true, carryover: -40 })).rows[0];
    expect(row.remainAmount).toBe('$60');       // available = 100 - 40
    expect(row.over).toBe(false);
  });

  it('spending past the reduced envelope reads over budget', () => {
    const row = budgetViews(state({ budget: 100, posted: 80, pending: 0, rollover: true, carryover: -40 })).rows[0];
    expect(row.over).toBe(true);                    // 80 > available 60
    expect(row.remainLabel).toBe('over');
    expect(row.remainAmount).toBe('$20'); // spent - available, said once (WHIT-712)
    expect(row.paceLabel).toBe('');
  });
});

// ── safe denominator: available <= 0 never yields NaN ────────────────────────
describe('budgetViews — empty/negative envelope bar math', () => {
  it('available 0 (fully borrowed) gives a finite bar, not NaN', () => {
    const row = budgetViews(state({ budget: 100, posted: 0, pending: 0, rollover: true, carryover: -100 })).rows[0];
    expect(Number.isFinite(row.postedPct)).toBe(true);
    expect(Number.isFinite(row.pendingPct)).toBe(true);
  });

  it('a negative envelope still gives a finite bar', () => {
    const row = budgetViews(state({ budget: 100, posted: 20, pending: 0, rollover: true, carryover: -150 })).rows[0];
    expect(Number.isFinite(row.postedPct)).toBe(true);
    expect(row.over).toBe(true); // spent 20 > available -50
  });
});

// ── rollover OFF ignores any stored buffer ───────────────────────────────────
describe('budgetViews — rollover off', () => {
  it('a carryover value is ignored while the flag is off', () => {
    const row = budgetViews(state({ budget: 100, posted: 30, pending: 0, rollover: false, carryover: 200 })).rows[0];
    expect(row.remainAmount).toBe('$70');   // available == budget (buffer ignored)
    expect(row.spentLabel).toBe('$30 of $100');
  });
});

// ── budgetDetail mirrors the envelope + surfaces the buffer line ─────────────
describe('budgetDetail — carryover', () => {
  const detail = (b: object) => budgetDetailFor(b, undefined, sink());

  it('positive buffer: header is the envelope and the rolled-over line shows', () => {
    const d = detail({ budget: 100, posted: 250, pending: 0, rollover: true, carryover: 200 });
    expect(d.ofBudget).toBe('of $300');                 // available
    // Not over budget (250 < 300), but far past this cycle's base pace (target = 100 × 0.5 = 50):
    // amber "over plan", matching the list's "over plan" for the same drawn-down sinking fund.
    expect(d.statusLabel).toBe('Over plan — ease up');
    expect(d.carryoverLine).toBe('+$200 left over from past cycles');
  });

  it('negative buffer over the envelope reads over + shows the borrowed line', () => {
    const d = detail({ budget: 100, posted: 80, pending: 0, rollover: true, carryover: -40 });
    expect(d.statusLabel).toBe('Over budget — ease up'); // 80 > available 60
    expect(d.carryoverLine).toBe('$40 short from past cycles');
  });

  it('no line when rollover is off', () => {
    const d = detail({ budget: 100, posted: 10, pending: 0, rollover: false, carryover: 200 });
    expect(d.carryoverLine).toBe('');
    expect(d.ofBudget).toBe('of $100');
  });
});

// ── toBudget maps + defaults ─────────────────────────────────────────────────
describe('toBudget — rollover fields', () => {
  it('defaults a legacy rollup (no rollover keys) to off / 0', () => {
    expect(toBudget('x', { target: 100, posted: 10, pending: 5 })).toEqual({
      id: 'x', budget: 100, posted: 10, pending: 5, rollover: false, carryover: 0, spreadAdjustment: 0,
    });
  });

  it('maps present rollover + carryover through', () => {
    expect(toBudget('x', { target: 100, posted: 10, pending: 5, rollover: true, carryover: 40 })).toEqual({
      id: 'x', budget: 100, posted: 10, pending: 5, rollover: true, carryover: 40, spreadAdjustment: 0,
    });
  });
});

// ===== WHIT-459 carryover label deadband (folded from budgetRolloverGaps.logic.test.ts, describe b)
describe('carryover detail line deadband (|value| must EXCEED 0.5 to show)', () => {
  const sink = cat({ id: 'sink', name: 'Sink', bucket: 'Lifestyle' });
  const detailFor = (carryover: number) =>
    budgetDetailFor({ budget: 100, posted: 0, rollover: true, carryover }, undefined, sink);

  it('exactly +0.5 shows no detail line (boundary is strict >)', () => {
    expect(detailFor(0.5).carryoverLine).toBe('');
  });

  it('exactly -0.5 shows no detail line (boundary is strict <)', () => {
    expect(detailFor(-0.5).carryoverLine).toBe('');
  });

  it('just past +0.5 shows the carried-over line', () => {
    expect(detailFor(0.51).carryoverLine).toBe('+$1 left over from past cycles');
  });

  it('just past -0.5 shows the borrowed line', () => {
    expect(detailFor(-0.51).carryoverLine).toBe('$1 short from past cycles');
  });
});
