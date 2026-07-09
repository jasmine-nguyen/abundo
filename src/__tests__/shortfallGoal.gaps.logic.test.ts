// WHIT-126 (adversarial gaps) — the shortfall solver's HORIZON math and cross-layer
// seams the implementer's shortfallGoal.logic.test.ts doesn't reach: a malformed
// stored goal date, the year boundary, month-granularity (day-of-month ignored), and
// a required repayment that overshoots the server's $1M sanitise cap. Pure over
// makeState + an injected `today`, so no real clock/TZ leak (runner pins Melbourne).
import { describe, it, expect } from '@jest/globals';
import { paydownView, aiGoalSignal, amortize } from '../context';
import { makeState, asShortfallGoal } from './factory';

const TODAY = new Date(2026, 6, 4);        // 2026-07-04 (matches the sibling suite)
// A 'none' loan: baseRepay+extra (4167) < monthly interest on the balance below.
const M = { original: 600000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 3667, extra: 500 };
const STATE = (balance: number, payoffGoalDate: string | null) =>
  makeState({ loanFacts: { ...M, payoffGoalDate }, homeLoan: { balance, asOf: null } });

describe('shortfall solver — malformed / unparseable goal date (WHIT-126)', () => {
  // monthsUntil splits on "-" and requires 3 finite parts; anything else -> null ->
  // paydownView must fall back to the static copy, never crash or emit a figure. A
  // corrupt/legacy stored value (the client hydrates whatever the row holds) hits this.
  it.each([
    ['not-a-date'],       // split('-') -> ["not","a","date"], Number -> NaN
    ['2035-06'],          // only 2 parts
    ['2035/06/01'],       // wrong separator -> 1 part
    ['garbage'],
    [''],                 // empty string
  ])('falls back (null shortfall fields) for a malformed goal date %p', (bad) => {
    const pv = paydownView(STATE(900000, bad), TODAY);
    expect(pv.mode).toBe('none');
    expect(pv.requiredRepay).toBeNull();
    expect(pv.goalDateLabel).toBeNull();
    // ...and no shortfall signal is emitted, so the AI layer stays spend-only.
    expect(aiGoalSignal(STATE(900000, bad), TODAY)).toBeNull();
  });
});

describe('shortfall solver — calendar boundaries (WHIT-126)', () => {
  it('spans a year boundary correctly (Jul 2026 -> Jan 2027 = 6 months)', () => {
    const pv = paydownView(STATE(900000, '2027-01-01'), TODAY);
    expect(pv.goalDateLabel).toBe('Jan 2027');
    // 6 whole months across the year rollover; round-trips through the forward solver.
    const months = (2027 - 2026) * 12 + (1 - 7);   // = 6
    expect(months).toBe(6);
    expect(amortize(900000, 5.74 / 100 / 12, pv.requiredRepay!)!.periods).toBeCloseTo(months, 3);
  });

  it('is month-granular: the day-of-month does not change the required repayment', () => {
    // monthsUntil ignores the day (payoff is rendered month-year only). The 1st and the
    // 30th of the same target month must solve identically. Fail-on-revert if a future
    // change makes monthsUntil day-aware without also making the label day-aware.
    const first = paydownView(STATE(900000, '2035-06-01'), TODAY);
    const last = paydownView(STATE(900000, '2035-06-30'), TODAY);
    expect(first.requiredRepay).toBe(last.requiredRepay);
    expect(first.goalDateLabel).toBe('Jun 2035');
    expect(last.goalDateLabel).toBe('Jun 2035');
  });

  it('treats the LAST day of the CURRENT month as no valid horizon (n=0 -> fallback)', () => {
    // 2026-07-31 is ~4 weeks out but still THIS month -> months=0 -> not > 0 -> fallback.
    const pv = paydownView(STATE(900000, '2026-07-31'), TODAY);
    expect(pv.requiredRepay).toBeNull();
    expect(pv.goalDateLabel).toBeNull();
  });
});

describe('shortfall solver — server $1M cap alignment (WHIT-126)', () => {
  // The server's _sanitise_goal drops the shortfall block when required_repayment
  // exceeds 1_000_000 (so the AI can't discuss it). The client mirrors that cap
  // (MAX_SHORTFALL_REPAYMENT), so a big loan with a near-term goal — which would need
  // > $1M/month — falls back to the static copy instead of showing a figure the AI
  // silently ignores. Fail-on-revert if the client cap is removed.
  it('falls back (no figure, no signal) when the required repayment would exceed the $1M cap', () => {
    const pv = paydownView(STATE(1_200_000, '2026-08-01'), TODAY); // next month, n=1 -> ~$1.2M/mo
    expect(pv.mode).toBe('none');
    expect(pv.requiredRepay).toBeNull();
    expect(pv.goalDateLabel).toBeNull();
    expect(aiGoalSignal(STATE(1_200_000, '2026-08-01'), TODAY)).toBeNull();
  });

  it('still solves when the required repayment sits under the cap', () => {
    // Same balance, a far enough date that the monthly figure stays under $1M.
    const g = asShortfallGoal(aiGoalSignal(STATE(1_200_000, '2040-06-01'), TODAY));
    expect(g.required_repayment).toBeLessThanOrEqual(1_000_000);
    expect(g.required_repayment).toBeGreaterThan(0);
  });
});
