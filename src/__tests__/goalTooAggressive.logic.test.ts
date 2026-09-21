// WHIT-215 — GAP tests for paydownView.goalTooAggressive (the "too soon — try a later
// date" hint flag). The implementer's shortfallGoal.logic.test.ts already locks: true
// >$1M / true >10× (far) / false realistic / false no-date+past / false $0-repay. These
// add the parts they DIDN'T pin: the EXACT 10× threshold flip, the $1M-cap interaction,
// that a paid-off loan with a goal date never flags, and (WHIT-218) that aiGoalSignal now
// SUPPRESSES the shortfall signal when the goal is flagged too aggressive. Pure over
// makeState + an injected `today`.
import { describe, it, expect } from '@jest/globals';
import { paydownView, requiredRepayment, aiGoalSignal } from '../context';
import { makeState } from './factory';

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

// (e) WHIT-218: the AI shortfall signal must AGREE with the "too soon" screen hint. When a
// payoff goal date is flagged goalTooAggressive, aiGoalSignal now SUPPRESSES the shortfall
// signal (emits null) instead of handing the model an absurd required figure — the screen
// already shows the "try a later date" hint (WHIT-215), so one place owns that message.
// Under the cap the figure IS solved (requiredRepay != null) yet the signal is null BECAUSE
// it's suppressed (not merely absent); over the cap it was already null.
describe('WHIT-218 goalTooAggressive — aiGoalSignal suppressed when too aggressive (NEW)', () => {
  it('under-cap "too aggressive" now SUPPRESSES the signal (real figure, but emit null)', () => {
    const s = stateWith({ payoffGoalDate: '2027-01-01' }, 900000); // 6 months → ~150k, flagged
    const pv = paydownView(s, TODAY);
    expect(pv.goalTooAggressive).toBe(true);
    expect(pv.requiredRepay).not.toBeNull();     // the figure IS solved (under the $1M cap)…
    expect(aiGoalSignal(s, TODAY)).toBeNull();   // …but NOT sent to the AI (WHIT-218 suppression)
  });

  // Fail-on-revert on a DISTINCT flagged state (different date + balance) so reverting the
  // `&& !pv.goalTooAggressive` gate reddens here too — and this isn't a dupe of the case above.
  it('a different under-cap flagged date is also suppressed (fail-on-revert)', () => {
    const s = stateWith({ payoffGoalDate: '2027-07-01' }, 950000); // 12 months → huge multiple, flagged
    const pv = paydownView(s, TODAY);
    expect(pv.mode).toBe('none');
    expect(pv.goalTooAggressive).toBe(true);
    expect(pv.requiredRepay).not.toBeNull();     // under the $1M cap, so the figure exists…
    expect(aiGoalSignal(s, TODAY)).toBeNull();   // …and is still suppressed
  });

  it('over-cap "too aggressive" still emits NO signal (figure null → null signal)', () => {
    const s = stateWith({ payoffGoalDate: '2026-08-01' }, 1_200_000);
    expect(paydownView(s, TODAY).goalTooAggressive).toBe(true);
    expect(aiGoalSignal(s, TODAY)).toBeNull();
  });
});
