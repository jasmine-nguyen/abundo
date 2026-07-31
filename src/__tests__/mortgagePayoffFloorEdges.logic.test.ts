// WHIT-391 GAPS — the paidPctLabel dollar-floor at its edges, over the REAL exported goalView.
// The implementer locked the single $1,200/$500k canonical ([E6]) + the 0.5 knife-edge ([A52]) and a
// small hard-coded invariant list. These add the boundaries those leave open, all against the real
// selector (no re-implementation), so a revert of the `paidDownFloor` reddens here:
//   - the UPPER seam of the floored band (where round(paidPct) naturally reaches 1) — no double-count
//   - DIFFERENT original loan sizes ($1M, $200k) — the floor keys on dollars, so the band scales
//   - a dense sweep answering "is there ANY balance where paidDownReady is true but the label is 0?"
//   - the complementary guard: a sub-$0.50 paydown (not ready) must NOT be fabricated up to 1
import { describe, it, expect } from '@jest/globals';
import { goalView } from '../context';
import { makeState, LOAN_FACTS } from './factory';

// original === 500000 by default; override for the different-loan-size cases.
const at = (balance: number, original = 500000) =>
  goalView(makeState({ loanFacts: { ...LOAN_FACTS, original }, homeLoan: { balance, asOf: null } }));

describe('goalView.paidPctLabel — WHIT-391 dollar-floor edges', () => {
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
