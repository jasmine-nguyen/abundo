// WHIT-372 — adversarial gap coverage for the shared coherence-clamped "% gone" label
// (goalView.paidPctLabel). The implementer locks 1000→99, 0→100, 0.43→100, 430000→14.
// These add the boundary/degenerate inputs those cases leave open, all against the REAL
// exported goalView (no re-implementation), so each reddens if the clamp/guard is broken.
import { describe, it, expect } from '@jest/globals';
import { goalView } from '../context';
import { makeState, EMPTY_LOAN_FACTS, LOAN_FACTS } from './factory';

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

// ===== WHIT-372 paidDownReady gate boundaries (folded from mortgagePaidDownReady.logic.test.ts)
// WHIT-372 — [A50..A52] the goalView.paidDownReady gate at its exact numeric boundaries.
// The screens both branch on this one flag, so its edge behaviour IS the behaviour. Runs the REAL
// selector over makeState (no re-implementation), so any revert of the `Math.round(paidOff) > 0`
// gate reddens here. Resolves the paidOff===0.5 "is it re-introduced incoherence?" question.
describe('goalView.paidDownReady — WHIT-372 gate boundaries', () => {
  // LOAN_FACTS.original === 500000 (supplied by makeState)
  // `at` block-scoped here: same name as the WHIT-391 helper below but a DIFFERENT impl.
  const at = (balance: number) => goalView(makeState({ homeLoan: { balance, asOf: null } }));

  // [A50] balance EXACTLY at the original → paidOff 0 → NOT ready (the at-original owing state).
  it('[A50] balance == original → paidDownReady false', () => {
    expect(at(500000).paidDownReady).toBe(false);
  });

  // [A51] balance ABOVE the original (redraw grew it) → paidOff negative → NOT ready.
  it('[A51] balance above original → paidDownReady false', () => {
    expect(at(500001).paidDownReady).toBe(false);
  });

  // A paydown that rounds DOWN to $0 (0 < paidOff < 0.5) → NOT ready (matches fmt's "$0").
  it('paidOff = 0.4 (rounds to $0) → paidDownReady false', () => {
    const v = at(499999.6);
    expect(v.paidOff).toBeCloseTo(0.4, 5);
    expect(v.paidDownReady).toBe(false);
  });

  // [A52] The knife-edge: paidOff === 0.5. Math.round(0.5)=1 > 0, so paidDownReady is TRUE and the
  // payoff block renders. WHIT-391 floors the headline to 1 so it AGREES with the "$1 paid" figure
  // (fmt(0.5)="$1") — no longer the old "$1 paid / 0% gone" contradiction.
  it('[A52] paidOff === 0.5 → paidDownReady TRUE and the % label floors to 1 (agrees with "$1 paid")', () => {
    const v = at(499999.5);
    expect(v.paidOff).toBe(0.5);
    expect(v.paidDownReady).toBe(true);   // the payoff block renders
    expect(v.paidPctLabel).toBe(1);       // WHIT-391: floored to 1, coherent with the dollar figure
  });
  // The full "paidDownReady ⇔ paidPctLabel >= 1" invariant is swept densely across loan sizes in
  // the WHIT-391 dollar-floor edges block below [F6].
});

// ===== WHIT-391 dollar-floor edges (folded from mortgagePayoffFloorEdges.logic.test.ts)
// WHIT-391 GAPS — the paidPctLabel dollar-floor at its edges, over the REAL exported goalView.
// The implementer locked the single $1,200/$500k canonical ([E6]) + the 0.5 knife-edge ([A52]) and a
// small hard-coded invariant list. These add the boundaries those leave open, all against the real
// selector (no re-implementation), so a revert of the `paidDownFloor` reddens here:
//   - the UPPER seam of the floored band (where round(paidPct) naturally reaches 1) — no double-count
//   - DIFFERENT original loan sizes ($1M, $200k) — the floor keys on dollars, so the band scales
//   - a dense sweep answering "is there ANY balance where paidDownReady is true but the label is 0?"
//   - the complementary guard: a sub-$0.50 paydown (not ready) must NOT be fabricated up to 1
describe('goalView.paidPctLabel — WHIT-391 dollar-floor edges', () => {
  // original === 500000 by default; override for the different-loan-size cases.
  // `at` block-scoped here: same name as the WHIT-372 helper above but a DIFFERENT impl.
  const at = (balance: number, original = 500000) =>
    goalView(makeState({ loanFacts: { ...LOAN_FACTS, original }, homeLoan: { balance, asOf: null } }));

  // On a $500k loan 1% == $5,000 paid, so round(paidPct) first reaches 1 at paidOff 2500 (paidPct 0.5).
  // The floored band is therefore paidOff ∈ [0.5, 2500). This walks the seam: 2499 is still floored to
  // 1, 2500 reaches 1 NATURALLY — and crucially the floor must NOT double it to 2 there (max, not sum).
  it('[F1] upper seam of the band: 2499 (floored) and 2500 (natural) both read exactly 1 — no double-count', () => {
    expect(at(497501).paidOff).toBe(2499);
    expect(at(497501).paidPctLabel).toBe(1);   // 0.4998% → round 0, floored to 1
    expect(at(497500).paidOff).toBe(2500);
    expect(at(497500).paidPct).toBeCloseTo(0.5, 6);
    expect(at(497500).paidPctLabel).toBe(1);   // 0.5% → round 1 naturally; floor is a no-op, NOT 2
  });

  // Just past the seam the floor is inert and the raw round governs: 1.4998% stays 1, 1.5% lifts to 2.
  // Proves the floor never CAPS a genuinely-larger paydown (it's Math.max, applied only at the bottom).
  it('[F2] above the band the raw round governs: 1.4998% → 1, 1.5% → 2 (floor never caps)', () => {
    expect(at(492501).paidPctLabel).toBe(1);   // paidOff 7499 → 1.4998% → 1
    expect(at(492500).paidPct).toBeCloseTo(1.5, 6);
    expect(at(492500).paidPctLabel).toBe(2);   // paidOff 7500 → 1.5% → 2
  });

  // $1M loan: 1% == $10,000, so a $1,200 paydown is 0.12% → round 0. The floor keys on DOLLARS
  // (round(paidOff) > 0), not a fixed 500k band, so it still lifts this to 1. Reverting the floor → 0.
  it('[F3] $1,200 paid on a $1,000,000 loan (0.12%) still floors to 1 — floor keys on dollars', () => {
    const v = at(998800, 1000000);
    expect(v.paidOff).toBe(1200);
    expect(v.paidPct).toBeCloseTo(0.12, 6);
    expect(v.paidDownReady).toBe(true);
    expect(v.paidPctLabel).toBe(1);
  });

  // $200k loan: the band is NARROWER (1% == $2,000). $900 paid is 0.45% → round 0 → floored to 1;
  // $1,200 paid is 0.6% → round 1 naturally. Both read 1, proving the band width scales with original.
  it('[F4] $200k loan: $900 (0.45%, floored) and $1,200 (0.6%, natural) both read 1', () => {
    expect(at(199100, 200000).paidOff).toBe(900);
    expect(at(199100, 200000).paidPctLabel).toBe(1);   // 0.45% floored
    expect(at(198800, 200000).paidPct).toBeCloseTo(0.6, 6);
    expect(at(198800, 200000).paidPctLabel).toBe(1);   // 0.6% natural round
  });

  // The complementary guard: a sub-$0.50 paydown rounds to $0, is NOT paidDownReady, and must NOT be
  // fabricated up to 1 — the floor's predicate is the SAME round(paidOff)>0 as the gate. Reverting the
  // gate/floor coupling (e.g. flooring on raw paidOff>0 instead of the rounded dollar) would redden this.
  it('[F5] a $0.40 paydown (rounds to $0, not ready) keeps the label at 0 — floor is not over-eager', () => {
    const v = at(499999.6);
    expect(v.paidOff).toBeCloseTo(0.4, 6);
    expect(v.paidDownReady).toBe(false);
    expect(v.paidPctLabel).toBe(0);
  });

  // THE question Jasmine asked: is there ANY balance where the block is shown (paidDownReady) yet the
  // rendered headline still reads 0? Dense sweep across the whole floored band AND several loan sizes,
  // at 25c granularity through the danger zone. paidDownReady === (label >= 1) must hold everywhere.
  it('[F6] exhaustive: across every loan size + a dense band sweep, paidDownReady ⇔ paidPctLabel ≥ 1', () => {
    const originals = [200000, 500000, 750000, 1000000];
    let readyRows = 0;
    for (const original of originals) {
      // fine sweep through the sub-1% danger zone, plus a few larger paydowns
      for (let paidOff = 0; paidOff <= original * 0.02; paidOff += 0.25) {
        const v = at(original - paidOff, original);
        if (v.paidDownReady) {
          readyRows += 1;
          expect(v.paidPctLabel).toBeGreaterThanOrEqual(1);   // never a "$X paid / 0% gone"
        } else {
          // not ready → nothing renders; the label may be 0, but must never be a fabricated ≥1 alone
          if (v.paidPctLabel >= 1) {
            // only acceptable when the raw pct itself already rounds to ≥1 (never via the dollar floor)
            expect(Math.round(v.paidPct)).toBeGreaterThanOrEqual(1);
          }
        }
      }
    }
    expect(readyRows).toBeGreaterThan(100);   // the sweep actually exercised the ready branch
  });
});
