// WHIT-114 — adversarial GAP tests for the payoff projection (paydownView).
// paydown.logic.test.ts locks the monthly happy paths (ahead/partial/none/flat/
// unready) + amortize's core. This file adds the edges that file leaves open: the
// mortgage cadence is decoupled from the user's pay cycle, the exact convergence
// boundary, the months-carry rounding spill, the interest-rounds-to-zero → 'flat'
// path, the month-end date-stepping, a NaN balance, and magnitude extremes. Every
// expected constant is computed INDEPENDENTLY, so a revert to seed or a broken
// carry/guard/step fails these.
import { describe, it, expect } from '@jest/globals';
import { paydownView } from '../context';
import { makeState } from './factory';

const TODAY = new Date(2026, 6, 4); // 2026-07-04
const M = { original: 600000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 3667, extra: 500 };

describe('paydownView — mortgage schedule is monthly, decoupled from pay cycle', () => {
  it('gives the SAME payoff whatever the pay cycle (7, 14 or 30 day)', () => {
    // The loan is a fixed monthly direct debit; the user's pay cycle must not move
    // the mortgage-free date. All three land on the identical month.
    const weekly = paydownView(makeState({ loanFacts: M, homeLoan: { balance: 528000, asOf: null }, cycleLen: 7 }), TODAY);
    const fortnightly = paydownView(makeState({ loanFacts: M, homeLoan: { balance: 528000, asOf: null }, cycleLen: 14 }), TODAY);
    const monthly = paydownView(makeState({ loanFacts: M, homeLoan: { balance: 528000, asOf: null }, cycleLen: 30 }), TODAY);
    expect(weekly.freedomLabel).toBe('Nov 2042');
    expect(fortnightly.freedomLabel).toBe('Nov 2042');
    expect(monthly.freedomLabel).toBe('Nov 2042');
    expect(weekly.aheadLabel).toBe('4y 1m');
    expect(monthly.aheadLabel).toBe('4y 1m');
  });
});

describe('paydownView — convergence boundary (selector level)', () => {
  it("returns 'none' just ABOVE the boundary (pmt <= B·i)", () => {
    // Monthly i = 5.74/100/12. The 4167 total payment == B·i at ~871,150; at
    // 871,200 the monthly interest edges past 4167 → never clears.
    const v = paydownView(makeState({ loanFacts: M, homeLoan: { balance: 871200, asOf: null } }), TODAY);
    expect(v.mode).toBe('none');
    expect(v.freedomLabel).toBe('');
  });

  it("returns 'partial' just BELOW it (extra clears, 3667-only still diverges)", () => {
    // 871,000: 4167 now creeps the balance down, but 3667 alone still loses to the
    // monthly interest → no finite baseline to beat → date alone.
    const v = paydownView(makeState({ loanFacts: M, homeLoan: { balance: 871000, asOf: null } }), TODAY);
    expect(v.mode).toBe('partial');
    expect(v.freedomLabel).toBe('Dec 2177');
    expect(v.aheadLabel).toBeNull();
    expect(v.interestDodged).toBeNull();
  });
});

describe('paydownView — rounding edges', () => {
  it("carries a months-rounds-to-12 delta into the year ('1y 0m', never '0y 12m')", () => {
    // B=246000: the saved delta's fractional year rounds to 12 months. The carry
    // must roll that into a whole year → '1y 0m'. Without the carry the label would
    // collapse to '0y 0m' and the (y>0||m>0) guard would flip the mode to 'flat'.
    const v = paydownView(makeState({ loanFacts: M, homeLoan: { balance: 246000, asOf: null } }), TODAY);
    expect(v.mode).toBe('ahead');
    expect(v.aheadLabel).toBe('1y 0m');
    expect(v.aheadLabel).not.toContain('12m');
    expect(v.freedomLabel).toBe('May 2032');
  });

  it("is 'flat' when the extra saves time but $0 interest (a 0% loan)", () => {
    // ratePct 0 → straight-line, zero interest on BOTH schedules, so nothing to
    // dodge even though the extra reaches payoff sooner. Math.round(dodged)===0
    // (not >0) → 'flat', not 'ahead'.
    const v = paydownView(makeState({ loanFacts: { ...M, ratePct: 0 }, homeLoan: { balance: 528000, asOf: null } }), TODAY);
    expect(v.mode).toBe('flat');
    expect(v.freedomLabel).toBe('Feb 2037');
    expect(v.aheadLabel).toBeNull();
    expect(v.interestDodged).toBeNull();
  });
});

describe('paydownView — calendar month stepping', () => {
  it('lands on the right month from a month-end start (no setMonth day-overflow)', () => {
    // A small monthly loan (1240 + 200) on B=100000 clears in 85 months. Stepping
    // 85 calendar months off Jan 31 must land Feb 2033 — a raw setMonth would roll
    // "Feb 31" into Mar 2033. Independently computed.
    const facts = { ...M, baseRepay: 1240, extra: 200 };
    const v = paydownView(makeState({ loanFacts: facts, homeLoan: { balance: 100000, asOf: null } }), new Date(2026, 0, 31));
    expect(v.mode).toBe('ahead');
    expect(v.freedomLabel).toBe('Feb 2033');
    expect(v.aheadLabel).toBe('1y 6m');
    expect(v.interestDodgedLabel).toBe('$4,810');
  });
});

describe('paydownView — a NaN balance never leaks to the UI', () => {
  it("treats a NaN balance as 'unready' (not an 'undefined NaN' card)", () => {
    const v = paydownView(makeState({ loanFacts: M, homeLoan: { balance: NaN, asOf: null } }), TODAY);
    expect(v.mode).toBe('unready');
    expect(v.freedomLabel).toBe('');
  });
});

describe('paydownView — magnitude extremes', () => {
  it("a tiny balance clears almost immediately → 'flat' (no whole month/dollar saved)", () => {
    const v = paydownView(makeState({ loanFacts: M, homeLoan: { balance: 100, asOf: null } }), TODAY);
    expect(v.mode).toBe('flat');
    expect(v.freedomLabel).toBe('Aug 2026');
  });

  it("a huge balance the payment can't dent → 'none'", () => {
    const v = paydownView(makeState({ loanFacts: M, homeLoan: { balance: 1_000_000_000, asOf: null } }), TODAY);
    expect(v.mode).toBe('none');
    expect(v.freedomLabel).toBe('');
  });
});
