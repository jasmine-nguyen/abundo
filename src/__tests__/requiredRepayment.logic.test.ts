// WHIT-126 — the inverse amortization solver: the $/month needed to clear a balance
// in a given number of months. It's the algebraic inverse of amortize (the shipped
// forward solver, WHIT-114), so the strongest anchor is a round-trip through amortize:
// a solver bug (sign, exponent, the i=0 branch) moves the round-tripped periods off n.
import { describe, it, expect } from '@jest/globals';
import { amortize, requiredRepayment } from '../context';

describe('requiredRepayment (WHIT-126)', () => {
  it('inverts amortize on a known case (100k @ 1%/mo, 2000/mo → ~69.66 months)', () => {
    // amortize(100000, 0.01, 2000).periods === -ln(0.5)/ln(1.01) ≈ 69.6607.
    const n = amortize(100000, 0.01, 2000)!.periods;
    expect(requiredRepayment(100000, 0.01, n)).toBeCloseTo(2000, 6);
  });

  it('round-trips through amortize for a spread of balances, rates, and horizons', () => {
    const cases: Array<[number, number, number]> = [
      [500000, 0.0574 / 12, 300],   // ~25y home loan
      [100000, 0.01, 42],
      [900000, 0.06 / 12, 180],     // a "won't pay off at current rate" balance
      [250000, 0.045 / 12, 123.5],  // fractional months are valid (amortize returns fractional periods)
    ];
    for (const [balance, i, n] of cases) {
      const pmt = requiredRepayment(balance, i, n);
      expect(pmt).not.toBeNull();
      expect(amortize(balance, i, pmt!)!.periods).toBeCloseTo(n, 4);
    }
  });

  it('is a straight-line divide at zero interest', () => {
    expect(requiredRepayment(12000, 0, 12)).toBe(1000);
    expect(requiredRepayment(12000, -0.01, 12)).toBe(1000); // i ≤ 0 → B/n, no 0/0
  });

  it('always exceeds the interest-only floor (B·i), approaching it as the horizon grows', () => {
    const floor = 100000 * 0.01;                 // 1000/mo just covers interest
    const long = requiredRepayment(100000, 0.01, 1200)!;  // a 100-year horizon
    expect(long).toBeGreaterThan(floor);         // never at/below the floor (amortize would reject it)
    expect(long).toBeCloseTo(floor, 0);          // but converges toward it for a long horizon
  });

  it('returns null when no repayment can be defined', () => {
    expect(requiredRepayment(100000, 0.01, 0)).toBeNull();    // no months
    expect(requiredRepayment(100000, 0.01, -5)).toBeNull();   // past horizon
    expect(requiredRepayment(0, 0.01, 12)).toBeNull();        // nothing owed
    expect(requiredRepayment(-100, 0.01, 12)).toBeNull();     // negative balance
    expect(requiredRepayment(100000, Infinity, 12)).toBeNull(); // non-finite rate
    expect(requiredRepayment(100000, NaN, 12)).toBeNull();
  });
});
