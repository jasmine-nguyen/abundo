// WHIT-215 — GAP tests for paydownView.goalTooAggressive (the "too soon — try a later
// date" hint flag). The implementer's shortfallGoal.logic.test.ts already locks: true
// >$1M / true >10× (far) / false realistic / false no-date+past / false $0-repay. These
// add the parts they DIDN'T pin: the EXACT 10× threshold flip, the $1M-cap interaction,
// that a paid-off loan with a goal date never flags, and that aiGoalSignal's AI payload
// is untouched by the new field. Pure over makeState + an injected `today`.
import { describe, it, expect } from '@jest/globals';
import { paydownView, requiredRepayment, aiGoalSignal } from '../context';
import { makeState, asShortfallGoal } from './factory';

const TODAY = new Date(2026, 6, 4);        // 2026-07-04 (Melbourne-pinned runner)
const I = 5.74 / 100 / 12;                 // the fixture monthly rate
// baseRepay+extra = 4167 < interest, so a 900k/1.2M balance stays in the 'none' branch.
const M = { original: 600000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 3667, extra: 500 };
const stateWith = (over: Partial<typeof M> & { payoffGoalDate?: string | null }, balance: number) =>
  makeState({ loanFacts: { ...M, ...over }, homeLoan: { balance, asOf: null } });

// (a) The EXACT boundary of the 10× rule. requiredRepay is independent of the current
// repayment, so we hold the figure fixed (900k, 24 months out → ~$39,783, under the $1M
// cap so it renders) and slide currentRepay across R/10. The flag must flip precisely at
// requiredRepay > 10×currentRepay — one dollar of current repayment either side of it.
describe('WHIT-215 goalTooAggressive — exact 10× threshold (NEW)', () => {
  // monthsUntil(2026-07-04 → 2028-07-01) = 24; keep this in sync with the date below.
  const R = requiredRepayment(900000, I, 24)!;   // ~39,783.19 — the production solver, not a re-impl

  it('the figure sits strictly between 3978×10 and 3979×10 (boundary is real, not luck)', () => {
    expect(R).toBeGreaterThan(3978 * 10);   // 39,780 < R
    expect(R).toBeLessThan(3979 * 10);      // R < 39,790
  });

  it('flags true when currentRepay is one dollar BELOW the 10× line (10×3978 < required)', () => {
    const pv = paydownView(stateWith({ baseRepay: 3478, extra: 500, payoffGoalDate: '2028-07-01' }, 900000), TODAY);
    expect(pv.mode).toBe('none');
    expect(pv.requiredRepay).not.toBeNull();          // under the $1M cap → figure shown
    expect(pv.requiredRepay!).toBeCloseTo(R, 6);
    expect(pv.goalTooAggressive).toBe(true);
  });

  it('does NOT flag one dollar ABOVE the 10× line (10×3979 > required)', () => {
    const pv = paydownView(stateWith({ baseRepay: 3479, extra: 500, payoffGoalDate: '2028-07-01' }, 900000), TODAY);
    expect(pv.mode).toBe('none');
    expect(pv.requiredRepay).not.toBeNull();
    expect(pv.goalTooAggressive).toBe(false);         // same date, same figure — only the multiple changed
  });
});

// (b) The $1M-cap boundary and its interaction with the flag. Next month (1 month out) on
// ~995k: R ≈ balance×(1+i). A $300 balance bump tips R across MAX_SHORTFALL_REPAYMENT,
// flipping figure-shown → figure-suppressed. The flag is true on BOTH sides (either the
// multiple or the cap trips it), but the FIGURE is what the cap gates.
describe('WHIT-215 goalTooAggressive — $1M cap interaction (NEW)', () => {
  it('just UNDER the cap: honest figure shown AND flagged (huge multiple)', () => {
    const pv = paydownView(stateWith({ payoffGoalDate: '2026-08-01' }, 995000), TODAY); // R ≈ 999,759
    expect(pv.requiredRepay).not.toBeNull();
    expect(pv.requiredRepay!).toBeLessThanOrEqual(1_000_000);
    expect(pv.requiredRepay!).toBeGreaterThan(10 * (M.baseRepay + M.extra));
    expect(pv.goalTooAggressive).toBe(true);
  });

  it('just OVER the cap: figure suppressed but still flagged (same too-soon date)', () => {
    const pv = paydownView(stateWith({ payoffGoalDate: '2026-08-01' }, 995300), TODAY); // R ≈ 1,000,060
    expect(pv.requiredRepay).toBeNull();               // over $1M → hidden (WHIT-126 behaviour intact)
    expect(pv.goalTooAggressive).toBe(true);           // WHIT-215: the hint replaces the static copy
  });
});

// (d) The flag is scoped to the 'none' branch only. A loan that DOES pay off must never
// show the hint, even with an absurdly-soon goal date set. Guards against a future change
// hoisting the flag out of the shortfall branch.
describe('WHIT-215 goalTooAggressive — paid-off modes never flag (NEW)', () => {
  const SOON = '2026-08-01'; // one month away — the most aggressive possible date

  it("'ahead' loan with a soon goal date → no hint", () => {
    const pv = paydownView(stateWith({ payoffGoalDate: SOON }, 528000), TODAY);
    expect(pv.mode).toBe('ahead');
    expect(pv.goalTooAggressive).toBe(false);
  });

  it("'partial' loan with a soon goal date → no hint", () => {
    const pv = paydownView(stateWith({ payoffGoalDate: SOON }, 815000), TODAY);
    expect(pv.mode).toBe('partial');
    expect(pv.goalTooAggressive).toBe(false);
  });

  it("'flat' loan (no extra) with a soon goal date → no hint", () => {
    const pv = paydownView(stateWith({ extra: 0, payoffGoalDate: SOON }, 528000), TODAY);
    expect(pv.mode).toBe('flat');
    expect(pv.goalTooAggressive).toBe(false);
  });
});

// (e) Regression: the new PaydownView field must not leak into — or alter — the AI goal
// signal. Under the cap the shortfall signal still carries the (absurd) required figure;
// over the cap aiGoalSignal is still null.
describe('WHIT-215 goalTooAggressive — aiGoalSignal payload unchanged (NEW)', () => {
  it('under-cap "too aggressive" still emits the SAME shortfall payload (no new field)', () => {
    const s = stateWith({ payoffGoalDate: '2027-01-01' }, 900000); // 6 months → ~150k, flagged
    const pv = paydownView(s, TODAY);
    expect(pv.goalTooAggressive).toBe(true);
    const g = asShortfallGoal(aiGoalSignal(s, TODAY));
    expect(g.payoff_mode).toBe('shortfall');
    expect(g.required_repayment).toBe(pv.requiredRepay);
    expect(g.required_extra).toBe(pv.requiredExtra);
    expect(Object.keys(g)).not.toContain('goalTooAggressive'); // the flag is UI-only
    expect(Object.keys(g)).not.toContain('goal_too_aggressive');
  });

  it('over-cap "too aggressive" still emits NO signal (figure null → null signal)', () => {
    const s = stateWith({ payoffGoalDate: '2026-08-01' }, 1_200_000);
    expect(paydownView(s, TODAY).goalTooAggressive).toBe(true);
    expect(aiGoalSignal(s, TODAY)).toBeNull();
  });
});
