// Bill SPREAD (WHIT-505) — client view math. A spend category's `spread` from the server
// carries a signed `adjustment` this cycle (a + cushion in the anchor cycle, a − slice in a
// payback cycle). budgetViews/budgetDetail fold it into the spendable envelope exactly like
// rollover's carryover (the two are mutually exclusive). budgetDetail also exposes the
// entry-point gating (spreadActive / canStartSpread / overspend); budgetEditInfo greys the
// rollover toggle off while a spread is active; spreadPreview mirrors the server's cent split.
import { describe, it, expect } from '@jest/globals';
import { budgetViews, budgetDetail, budgetEditInfo, budgetSpreadEligibility, toBudget, spreadPreview, cycleName } from '../context';
import type { Category, Budget } from '../context';
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

// ── budgetEditInfo: the Smoothing switch, shown-but-locked under an active spread (WHIT-550) ──
describe('budgetEditInfo — Smoothing switch vs spread', () => {
  const editInfo = (b: object) => budgetEditInfo({
    budgets: [budget({ id: 'sink', ...b })], category: (id: string) => (id === 'sink' ? sink() : undefined),
    cycleName: () => cycleName(14),
  }, 'sink');

  it('shows the switch but locks it ON while a spread is active', () => {
    const info = editInfo({ spread: plan() });
    expect(info.smoothingShown).toBe(true);    // still rendered — a spread IS smoothing
    expect(info.smoothingLocked).toBe(true);   // but not editable
    expect(info.spreadActive).toBe(true);
  });

  it('shows an editable switch on a plain spend budget', () => {
    const info = editInfo({});
    expect(info.smoothingShown).toBe(true);
    expect(info.smoothingLocked).toBe(false);
    expect(info.spreadActive).toBe(false);
  });

  it('hides the switch for Income and Savings (no smoothing on a floor)', () => {
    const infoFor = (category: Category) => budgetEditInfo({
      budgets: [budget({ id: 'x' })],
      category: () => category,
      cycleName: () => cycleName(14),
    }, 'x');
    expect(infoFor(cat({ id: 'x', name: 'X', bucket: 'Income' })).smoothingShown).toBe(false);
    expect(infoFor(cat({ id: 'x', name: 'X', bucket: 'Savings' })).smoothingShown).toBe(false);
  });

  // GAP [A-L1] WHIT-550 — a spend budget with rollover already ON but NO spread must NOT be
  // locked: the switch stays editable so save() writes the flag. Guards against a regression
  // that keys `smoothingLocked` off `rolloverOn`/`existing` instead of `spread`.
  it('does NOT lock the switch for a rollover-ON budget without a spread', () => {
    const info = editInfo({ rollover: true, carryover: 40 });
    expect(info.smoothingShown).toBe(true);
    expect(info.smoothingLocked).toBe(false);   // editable — not accidentally locked
    expect(info.rolloverOn).toBe(true);         // seeds the switch ON from the stored flag
    expect(info.spreadActive).toBe(false);
  });

  // GAP [A-L2] WHIT-550 — the locked help copy is a DISTINCT string from the normal help, and
  // names the spread as the reason. Fail-on-revert: point smoothingLockedHelp at smoothingHelp
  // (or drop the "Manage the spread" sentence) and this goes red.
  it('exposes a distinct locked-help string that points the user at the spread', () => {
    const info = editInfo({ spread: plan() });
    expect(info.smoothingLockedHelp).toBe('On while this bill is spread over several cycles. Manage the spread from the bill instead.');
    expect(info.smoothingLockedHelp).not.toBe(info.smoothingHelp);
    expect(info.smoothingHelp).toContain('carries forward');   // normal copy still the smoothing pitch
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

// ── budgetSpreadEligibility: the shared rule both entry points read (WHIT-556) ────────────────
describe('budgetSpreadEligibility — shared entry + overspend', () => {
  const spend = cat({ id: 'sink', name: 'Sink', bucket: 'Lifestyle' });
  const bud = (over = {}) => budget({ id: 'sink', budget: 100, posted: 0, pending: 0, ...over });

  it('hidden with no category or no budget', () => {
    expect(budgetSpreadEligibility(undefined, bud()).entry).toBe('hidden');
    expect(budgetSpreadEligibility(spend, undefined).entry).toBe('hidden');
  });

  it('hidden for Income and Savings (spend-only)', () => {
    expect(budgetSpreadEligibility(cat({ id: 'sink', bucket: 'Income' }), bud({ posted: 500 })).entry).toBe('hidden');
    expect(budgetSpreadEligibility(cat({ id: 'sink', bucket: 'Savings' }), bud({ posted: 500 })).entry).toBe('hidden');
  });

  it('edit when a plan is active — even if the cushion cleared "over"', () => {
    expect(budgetSpreadEligibility(spend, bud({ posted: 0, spread: plan() })).entry).toBe('edit');
  });

  it('hidden when rollover is on, even over budget (rollover XOR spread)', () => {
    expect(budgetSpreadEligibility(spend, bud({ posted: 200, rollover: true, carryover: 0 })).entry).toBe('hidden');
  });

  it('start when over by at least a whole cent, and reports the whole-cent overspend', () => {
    const r = budgetSpreadEligibility(spend, bud({ posted: 130.1 }));
    expect(r.entry).toBe('start');
    expect(r.overspend).toBe(30.1);   // spent - available, rounded to cents (the prefill)
  });

  it('hidden on a sub-cent overshoot (would spread an unsaveable $0)', () => {
    const r = budgetSpreadEligibility(spend, bud({ posted: 100.004 }));
    expect(r.entry).toBe('hidden');
    expect(r.overspend).toBe(0);
  });

  it('hidden exactly at budget (strict over)', () => {
    expect(budgetSpreadEligibility(spend, bud({ posted: 100 })).entry).toBe('hidden');
  });

  it('honours the server-computed available over the parts-sum fallback', () => {
    // available 300 sent by the server → spent 130 is NOT over → hidden, even though budget is 100.
    expect(budgetSpreadEligibility(spend, bud({ posted: 130, available: 300 })).entry).toBe('hidden');
  });
});

// ── parity: budgetDetail.canStartSpread + overspend come from the shared rule (WHIT-556) ────────
describe('budgetDetail.{canStartSpread,overspend} ≡ budgetSpreadEligibility', () => {
  const cases: Array<[string, object]> = [
    ['over budget, no plan', { budget: 100, posted: 130.1, pending: 0 }],
    ['active plan', { budget: 100, posted: 0, pending: 0, spread: { amount: 200, cycles: 4, index: 1, adjustment: -50 } }],
    ['rollover on + over', { budget: 100, posted: 200, pending: 0, rollover: true, carryover: 0 }],
    ['sub-cent overshoot', { budget: 100, posted: 100.004, pending: 0 }],
    ['under budget', { budget: 100, posted: 40, pending: 0 }],
  ];
  it.each(cases)('parity: %s', (_label, over) => {
    const c = sink();
    const b = budget({ id: 'sink', ...over }) as Budget;
    const detailResult = budgetDetail(makeState({ categories: [c], budgets: [b], cycleLen: 14, daysLeft: 7 }), 'sink')!;
    const elig = budgetSpreadEligibility(c, b);
    expect(detailResult.canStartSpread).toBe(elig.entry === 'start');
    expect(detailResult.overspend).toBe(elig.overspend);
  });
});
