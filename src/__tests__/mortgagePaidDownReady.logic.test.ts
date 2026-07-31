// WHIT-372 — [A50..A52] the goalView.paidDownReady gate at its exact numeric boundaries.
// The screens both branch on this one flag, so its edge behaviour IS the behaviour. Runs the REAL
// selector over makeState (no re-implementation), so any revert of the `Math.round(paidOff) > 0`
// gate reddens here. Resolves the paidOff===0.5 "is it re-introduced incoherence?" question.
import { describe, it, expect } from '@jest/globals';
import { goalView } from '../context';
import { makeState } from './factory';

// LOAN_FACTS.original === 500000 (supplied by makeState)
const at = (balance: number) => goalView(makeState({ homeLoan: { balance, asOf: null } }));

describe('goalView.paidDownReady — WHIT-372 gate boundaries', () => {
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
  // mortgagePayoffFloorEdges.logic.test.ts [F6].
});
