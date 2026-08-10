// Budget ROLLOVER (envelope carryover) — client view math.
// budgetViews/budgetDetail spend this cycle's AVAILABLE envelope (target + buffer): a sinking
// fund adds room, a spike carries a deficit. Over-budget (red) is measured against available,
// pace stays on the base target, and the bar denominator can never divide by 0. toBudget
// defaults the fields for a non-rollover/legacy budget.
import { describe, it, expect } from '@jest/globals';
import { budgetViews, budgetDetail, toBudget } from '../context';
import { makeState, cat, budget } from './factory';

const sink = (over = {}) => cat({ id: 'sink', name: 'Sink', bucket: 'Lifestyle', ...over });
const state = (b: object) => makeState({
  categories: [sink()], budgets: [budget({ id: 'sink', ...b })],
  cycleLen: 14, daysLeft: 7, // elapsed 0.5 → base pace target = budget * 0.5
});

// ── positive buffer: unused budget accumulates ───────────────────────────────
describe('budgetViews — positive carryover (sinking fund)', () => {
  it('adds the buffer to the spendable envelope and shows the rolled-over chip', () => {
    const { rows, totBudget, totSpent, totRemain } = budgetViews(
      state({ budget: 100, posted: 0, pending: 0, rollover: true, carryover: 200 }));
    const row = rows[0];
    expect(row.remainAmount).toBe('$300');      // available = 100 + 200
    expect(row.remainLabel).toBe('left');
    expect(row.over).toBe(false);
    expect(row.spentLabel).toBe('$0 spent of $300'); // "of" is the available envelope
    expect(row.carryoverLabel).toBe('+$200 rolled over');
    // Hero totals count the envelope so the top number matches the rows.
    expect([totBudget, totSpent, totRemain]).toEqual([300, 0, 300]);
  });

  it('drawing down the buffer past the base target is NOT over budget, but pace still warns', () => {
    // spent 150 > base target 100, but < available 300 → calm on the ceiling. Pace is measured
    // on the BASE target (100 * 0.5 = 50), so 150 is well over pace (amber), independently.
    const row = budgetViews(state({ budget: 100, posted: 150, pending: 0, rollover: true, carryover: 200 })).rows[0];
    expect(row.over).toBe(false);
    expect(row.remainAmount).toBe('$150');      // 300 - 150
    expect(row.paceLabel).toContain('over pace');  // pace stays on the base target
  });
});

// ── negative buffer: overspend carries as a deficit ──────────────────────────
describe('budgetViews — negative carryover (borrow)', () => {
  it('a deficit lowers the envelope and shows the borrowed chip', () => {
    const row = budgetViews(state({ budget: 100, posted: 0, pending: 0, rollover: true, carryover: -40 })).rows[0];
    expect(row.remainAmount).toBe('$60');       // available = 100 - 40
    expect(row.over).toBe(false);
    expect(row.carryoverLabel).toBe('$40 borrowed');
  });

  it('spending past the reduced envelope reads over budget', () => {
    const row = budgetViews(state({ budget: 100, posted: 80, pending: 0, rollover: true, carryover: -40 })).rows[0];
    expect(row.over).toBe(true);                    // 80 > available 60
    expect(row.remainLabel).toBe('over');
    expect(row.paceLabel).toBe('$20 over budget'); // spent - available
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
    expect(row.spentLabel).toBe('$30 spent of $100');
    expect(row.carryoverLabel).toBe('');
  });
});

// ── budgetDetail mirrors the envelope + surfaces the buffer line ─────────────
describe('budgetDetail — carryover', () => {
  const detail = (b: object) => budgetDetail(makeState({
    categories: [sink()], budgets: [budget({ id: 'sink', ...b })], cycleLen: 14, daysLeft: 7,
  }), 'sink')!;

  it('positive buffer: header is the envelope and the rolled-over line shows', () => {
    const d = detail({ budget: 100, posted: 250, pending: 0, rollover: true, carryover: 200 });
    expect(d.ofBudget).toBe('of $300');                 // available
    expect(d.statusLabel).toBe('On target — keep it up'); // 250 < available 300 → not over
    expect(d.carryoverLine).toBe('Includes $200 rolled over from past cycles');
  });

  it('negative buffer over the envelope reads over + shows the borrowed line', () => {
    const d = detail({ budget: 100, posted: 80, pending: 0, rollover: true, carryover: -40 });
    expect(d.statusLabel).toBe('Over budget — ease up'); // 80 > available 60
    expect(d.carryoverLine).toBe('Includes $40 borrowed from this cycle');
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
      id: 'x', budget: 100, posted: 10, pending: 5, rollover: false, carryover: 0,
    });
  });

  it('maps present rollover + carryover through', () => {
    expect(toBudget('x', { target: 100, posted: 10, pending: 5, rollover: true, carryover: 40 })).toEqual({
      id: 'x', budget: 100, posted: 10, pending: 5, rollover: true, carryover: 40,
    });
  });
});
