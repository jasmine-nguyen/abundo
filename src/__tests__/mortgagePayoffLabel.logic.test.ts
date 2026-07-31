// WHIT-372 — adversarial gap coverage for the shared coherence-clamped "% gone" label
// (goalView.paidPctLabel). The implementer locks 1000→99, 0→100, 0.43→100, 430000→14.
// These add the boundary/degenerate inputs those cases leave open, all against the REAL
// exported goalView (no re-implementation), so each reddens if the clamp/guard is broken.
import { describe, it, expect } from '@jest/globals';
import { goalView } from '../context';
import { makeState, EMPTY_LOAN_FACTS } from './factory';

describe('goalView.paidPctLabel — WHIT-372 boundary + degenerate inputs', () => {
  // [E1] The EXACT Math.round half-up boundary. original 500000, balance 2500 -> paidPct is
  // EXACTLY 99.5, which Math.round lifts to 100 -> the clamp holds it at 99. Its unique value over
  // the implementer's 99.8 case is the second assertion: the raw paidPct (what the progress Bar
  // uses) stays 99.5, proving the bar is NOT clamped while the label is.
  it('[E1] paidPct exactly 99.5 (balance 2500) clamps the label to 99, raw paidPct stays 99.5', () => {
    const v = goalView(makeState({ homeLoan: { balance: 2500, asOf: null } }));
    expect(v.paidPctLabel).toBe(99);
    expect(v.paidPct).toBeCloseTo(99.5, 5);   // the bar value is NOT clamped
  });

  // [E2] Balance slightly OVER the original (a redraw / refinance that grew the loan). paidOff is
  // negative, paidPct clamps to 0 — the label must be a coherent 0, never a negative or NaN "% gone".
  // Both screens now gate this state out via goalView.paidDownReady (WHIT-372), but the selector is
  // the source of truth, so the value it returns here must still be sane.
  it('[E2] balance above original -> paidPctLabel is a coherent 0 (not negative/NaN)', () => {
    const v = goalView(makeState({ homeLoan: { balance: 500001, asOf: null } }));
    expect(v.paidPctLabel).toBe(0);
    expect(Number.isFinite(v.paidPctLabel)).toBe(true);
  });

  // [E3] Balance UNKNOWN (null, still loading). paidPctLabel must be a finite 0, never NaN/undefined:
  // both screens currently gate the label behind balanceKnown, but if a future refactor ungated it,
  // a NaN here would render "NaN% gone". This pins the safe default at the source.
  it('[E3] unknown balance (null) -> paidPctLabel is a finite 0, never NaN', () => {
    const v = goalView(makeState({ homeLoan: { balance: null, asOf: null } }));
    expect(v.balanceKnown).toBe(false);
    expect(v.paidPctLabel).toBe(0);
    expect(Number.isNaN(v.paidPctLabel)).toBe(false);
  });

  // [E4] Facts NOT set yet (loan form never saved) with a $0 balance — the exact input that would
  // leak a stray "100% gone" if balanceCleared didn't require factsReady: there's no original to
  // measure against, so "100% gone" is meaningless. The label must be a coherent 0. Fail-on-revert:
  // drop the `factsReady &&` guard on balanceCleared and this flips to 100 (Math.round(0) === 0).
  it('[E4] facts unset with a $0 balance -> paidPctLabel is 0, never a fabricated "100% gone"', () => {
    const v = goalView(makeState({ loanFacts: EMPTY_LOAN_FACTS, homeLoan: { balance: 0, asOf: null } }));
    expect(v.factsReady).toBe(false);
    expect(v.paidPctLabel).toBe(0);
  });

  // [E6] WHIT-391 — a real dollar paydown under ~0.5% of the loan must never headline "0% gone".
  // The card's example: $1,200 paid on $500,000 = 0.24% → the raw round is 0, but the label is
  // floored to 1 so it stays coherent with the "$1,200 paid" figure. Fail-on-revert: drop the
  // hasRoundedPaydown floor and this drops back to 0 next to a "$1,200 paid" block.
  it('[E6] $1,200 paid on $500k -> paidPctLabel floored to 1, coherent with the dollar figure', () => {
    const v = goalView(makeState({ homeLoan: { balance: 498800, asOf: null } }));
    expect(v.paidOff).toBe(1200);
    expect(v.paidDownReady).toBe(true);
    expect(v.paidPctLabel).toBe(1);   // NOT 0 — WHIT-391 floor
    expect(v.paidPct).toBeCloseTo(0.24, 5);  // the raw Bar fill stays the true 0.24%
  });
});
