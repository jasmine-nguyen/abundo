// WHIT-732 QA — edges of the calmer "over plan" rule and the base-pace tick: the exact
// half-daily-plan boundary, end of cycle, pending, over rows, income rows, and the row and the
// detail screen agreeing across a grid of envelopes and clocks.
import { describe, it, expect } from '@jest/globals';
import { C } from '../theme';
import { availableToSpend, paceWarning, pacePct, paceTarget } from '../budgetMath';
import { budgetViews, budgetDetail } from '../context';
import { makeState, budget } from './factory';
import { budgetRowFor as rowFor, budgetDetailFor as detailFor } from './support/budgetsTab';
import { SALARY } from './support/categories';
import type { Budget } from '../model';

const HALFWAY = { cycleLen: 14, daysLeft: 7 };

describe('paceWarning — the rule itself', () => {
  // [A1] (P0) strict "<": daily room exactly half the daily plan stays quiet; a cent more spent warns.
  it('[A1] exactly half the daily plan left is quiet; a little less warns', () => {
    // available 140, 14-day cycle → plan $10/day, half = $5. 7 days left: $35 left == $5/day.
    expect(paceWarning({ spent: 105, target: 70, available: 140, over: false }, HALFWAY)).toBe(false);
    expect(paceWarning({ spent: 105.01, target: 70, available: 140, over: false }, HALFWAY)).toBe(true);
  });

  // [A2] (P0) an over-budget row never carries the pace warning (red already says it).
  it('[A2] over budget → no pace warning', () => {
    expect(paceWarning({ spent: 150, target: 50, available: 100, over: true }, HALFWAY)).toBe(false);
  });

  // [A3] (P0) ahead by exactly 50c stays quiet even with no room left.
  it('[A3] ahead by exactly $0.50 → quiet, even with almost nothing left per day', () => {
    expect(paceWarning({ spent: 50.5, target: 50, available: 51, over: false }, HALFWAY)).toBe(false);
    expect(paceWarning({ spent: 50.51, target: 50, available: 51, over: false }, HALFWAY)).toBe(true);
  });

  // [A4] (P1) last day (0 days left) divides by 1, not 0.
  it('[A4] 0 days left: room left counts as one day', () => {
    // available 140 → half plan $5. $6 left over "1" day → quiet; $4 left → warns.
    expect(paceWarning({ spent: 134, target: 100, available: 140, over: false }, { cycleLen: 14, daysLeft: 0 })).toBe(false);
    expect(paceWarning({ spent: 136, target: 100, available: 140, over: false }, { cycleLen: 14, daysLeft: 0 })).toBe(true);
  });
});

describe('pacePct — where the tick goes', () => {
  // [A5] (P0) the tick is the base target over the bar's scale, rounded and clamped.
  it('[A5] rounds and clamps to 0–100', () => {
    expect(pacePct(50, 200)).toBe(25);
    expect(pacePct(50, 160)).toBe(31);
    expect(pacePct(50, 40)).toBe(100);
    expect(pacePct(0, 100)).toBe(0);
  });
});

describe('budget rows with the new rule', () => {
  // [A6] (P0) slightly ahead → no line at all, not even "under plan" (dead zone between the two).
  it('[A6] ahead of pace but with room → no line, not urgent', () => {
    const row = rowFor({ budget: 100, posted: 74, pending: 0 });
    expect(row.paceLabel).toBe('');
    expect(row.behindPace).toBe(false);
  });

  // [A7] (P0) pending spend counts toward the warning on the row.
  it('[A7] pending pushes a row into "over plan"', () => {
    expect(rowFor({ budget: 100, posted: 70, pending: 0 }).paceLabel).toBe('');
    const row = rowFor({ budget: 100, posted: 70, pending: 15 });
    expect(row.paceLabel).toBe('$35 over plan');
    expect(row.paceColor).toBe(C.textInfo);
    expect(row.behindPace).toBe(true);
  });

  // [A8] (P0) no spending row's pace line is ever amber, across a sweep of spends.
  it('[A8] the pace line is never amber', () => {
    for (let posted = 0; posted <= 100; posted += 5) {
      const row = rowFor({ budget: 100, posted, pending: 0 });
      expect(row.paceColor).not.toBe(C.warn);
    }
  });

  // [A9] (P0) a rollover leftovers row only warns on the envelope's daily room, not the base pace alone.
  it('[A9] $200 envelope: $150 spent is quiet, $180 spent warns', () => {
    const roomy = rowFor({ budget: 100, posted: 150, pending: 0, rollover: true, carryover: 100 });
    expect(roomy.paceLabel).toBe('');
    expect(roomy.behindPace).toBe(false);
    const tight = rowFor({ budget: 100, posted: 180, pending: 0, rollover: true, carryover: 100 });
    expect(tight.paceLabel).toBe('$130 over plan');
    expect(tight.behindPace).toBe(true);
  });

  // [A10] (P0) the tick and the fill meet when spend is exactly on the base pace, so the words
  // ("on plan") and the bar agree on rollover, past-overspend and spread rows.
  it('[A10] spent == base pace → the fill ends at the tick', () => {
    const cases: Partial<Budget>[] = [
      { rollover: true, carryover: 100 },
      { rollover: true, carryover: 60 },
      { rollover: true, carryover: -20 },
      { spreadAdjustment: 60, spread: { amount: 120, cycles: 2, index: 1, adjustment: 60 } },
      {},
    ];
    for (const extra of cases) {
      const row = rowFor({ budget: 100, posted: 50, pending: 0, ...extra });
      expect(row.paceLabel).toBe('');
      expect(row.targetPct).toBe(Math.round(row.postedPct));
    }
  });

  // [A11] (P1) income rows keep the elapsed tick (hidden anyway) and never warn.
  it('[A11] income row: tick at elapsed, no warning', () => {
    const row = rowFor({ budget: 5000, posted: 4900, pending: 0 }, SALARY);
    expect(row.targetPct).toBe(50);
    expect(row.behindPace).toBe(false);
    const d = detailFor({ budget: 5000, posted: 4900 }, HALFWAY, SALARY);
    expect(d.targetPct).toBe(50);
  });

  // [A12] (P1) over-budget rows: no pace warning even though they're far ahead.
  it('[A12] over budget → behindPace false (the red amount speaks)', () => {
    const row = rowFor({ budget: 100, posted: 130, pending: 0 });
    expect(row.over).toBe(true);
    expect(row.behindPace).toBe(false);
  });
});

describe('the row and the detail screen agree (WHIT-732 + WHIT-715)', () => {
  // [A13] (P0) across envelopes and clocks: the row warns iff the detail says "Over plan", and
  // both put the tick in the same place.
  it('[A13] row warning == detail "Over plan", same tick, same muted colour', () => {
    const envelopes: Partial<Budget>[] = [
      {},
      { rollover: true, carryover: 100 },
      { rollover: true, carryover: -30 },
      { spreadAdjustment: 60, spread: { amount: 120, cycles: 2, index: 1, adjustment: 60 } },
    ];
    const clocks = [{ cycleLen: 14, daysLeft: 13 }, HALFWAY, { cycleLen: 14, daysLeft: 1 }, { cycleLen: 30, daysLeft: 0 }];
    let warned = 0, quiet = 0;
    for (const extra of envelopes) for (const clock of clocks) for (let posted = 0; posted <= 200; posted += 10) {
      const b = budget({ id: 'coffee', budget: 100, posted, pending: 0, ...extra });
      const state = makeState({ budgets: [b], ...clock });
      const row = budgetViews(state).rows[0];
      const detail = budgetDetail(state, 'coffee')!;
      expect(detail.statusLabel === 'Over plan — ease up').toBe(row.behindPace);
      if (row.behindPace) {
        expect(row.paceColor).toBe(C.textInfo);
        expect(detail.statusColor).toBe(C.textInfo);
        warned++;
      } else if (!row.over) quiet++;
      expect(detail.targetPct).toBe(row.targetPct);
      const available = availableToSpend(b);
      expect(row.targetPct).toBe(pacePct(paceTarget(b, clock), available > 0 ? available : 100));
    }
    expect(warned).toBeGreaterThan(0);
    expect(quiet).toBeGreaterThan(0);
  });
});
