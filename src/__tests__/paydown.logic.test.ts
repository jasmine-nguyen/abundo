// WHIT-114 — the pure payoff projection: amortize() core + paydownView selector.
// No provider/React — a cast partial AppContext (makeState), like the sibling
// selector logic tests. A home loan is repaid MONTHLY (a fixed direct debit), so
// the projection is 12 periods/year regardless of the user's pay cycle. Expected
// constants are computed INDEPENDENTLY (a standalone closed-form calc), so a
// selector that reverts to the old seed ('Aug 2045' / '4y 3m' / $58,200) fails.
import { describe, it, expect } from '@jest/globals';
import { amortize, paydownView } from '../context';
import { makeState, EMPTY_LOAN_FACTS } from './factory';

// A fixed "today" so the projected month-year is deterministic.
const TODAY = new Date(2026, 6, 4); // 2026-07-04

// Monthly-realistic loan facts (a ~$3,667/mo P&I mortgage), the WHIT-114 shape.
const M = { original: 600000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 3667, extra: 500 };

describe('amortize', () => {
  it('solves periods + total interest for a converging schedule', () => {
    // B=100000, i=0.01/month, pmt=2000 → n = -ln(1 − 1000/2000)/ln(1.01).
    const a = amortize(100000, 0.01, 2000)!;
    expect(a.periods).toBeCloseTo(69.66072, 4);
    expect(a.totalInterest).toBeCloseTo(39321.434, 2);
  });

  it('is straight-line when the rate is zero (no interest accrues)', () => {
    const a = amortize(12000, 0, 1000)!;
    expect(a.periods).toBe(12);
    expect(a.totalInterest).toBe(0);
  });

  it('returns null when the payment cannot cover the interest (never pays off)', () => {
    expect(amortize(100000, 0.01, 1000)).toBeNull(); // pmt == B·i exactly
    expect(amortize(100000, 0.01, 900)).toBeNull(); // pmt < B·i
  });

  it('returns null for a non-positive payment', () => {
    expect(amortize(100000, 0.01, 0)).toBeNull();
    expect(amortize(100000, 0.01, -50)).toBeNull();
  });

  it('is already paid off (0 periods, 0 interest) when nothing is owing', () => {
    expect(amortize(0, 0.01, 1000)).toEqual({ periods: 0, totalInterest: 0 });
    expect(amortize(-500, 0.01, 1000)).toEqual({ periods: 0, totalInterest: 0 });
  });
});

describe('paydownView (monthly loan schedule)', () => {
  it("is 'unready' until loan facts are saved", () => {
    const v = paydownView(makeState({ loanFacts: EMPTY_LOAN_FACTS, homeLoan: { balance: 528000, asOf: null } }), TODAY);
    expect(v.mode).toBe('unready');
    expect(v.freedomLabel).toBe('');
  });

  it("is 'unready' until the live balance loads", () => {
    const v = paydownView(makeState({ loanFacts: M, homeLoan: { balance: null, asOf: null } }), TODAY);
    expect(v.mode).toBe('unready');
  });

  it("'ahead': a balance the monthly schedule clears with room to spare", () => {
    // B=528000 @5.74%, 3667 + 500 extra. Independently computed: payoff Nov 2042,
    // 4y 1m sooner than 3667-only, ~$83,331 interest dodged.
    const v = paydownView(makeState({ loanFacts: M, homeLoan: { balance: 528000, asOf: null } }), TODAY);
    expect(v.mode).toBe('ahead');
    expect(v.freedomLabel).toBe('Nov 2042');
    expect(v.aheadLabel).toBe('4y 1m');
    expect(v.interestDodgedLabel).toBe('$83,331');
    // fail-on-revert: never the old seed values.
    expect(v.freedomLabel).not.toBe('Aug 2045');
    expect(v.interestDodgedLabel).not.toBe('$58,200');
  });

  it("'partial': pays off ONLY because of the extra (scheduled-alone diverges)", () => {
    // B=815000: the 3667-only monthly interest (~3898) exceeds the 3667 payment, so
    // the baseline never clears — but 4167 does. Show the date, no early/dodged.
    const v = paydownView(makeState({ loanFacts: M, homeLoan: { balance: 815000, asOf: null } }), TODAY);
    expect(v.mode).toBe('partial');
    expect(v.freedomLabel).toBe('Jun 2074');
    expect(v.aheadLabel).toBeNull();
    expect(v.interestDodged).toBeNull();
  });

  it("'none': won't pay off even with the extra (payment ≤ interest)", () => {
    // B=900000: monthly interest (~4305) exceeds even the 4167 total payment.
    const v = paydownView(makeState({ loanFacts: M, homeLoan: { balance: 900000, asOf: null } }), TODAY);
    expect(v.mode).toBe('none');
    expect(v.freedomLabel).toBe('');
  });

  it("'flat': no extra → a payoff date but nothing to compare against", () => {
    const v = paydownView(makeState({ loanFacts: { ...M, extra: 0 }, homeLoan: { balance: 528000, asOf: null } }), TODAY);
    expect(v.mode).toBe('flat');
    expect(v.freedomLabel).toBe('Dec 2046');
    expect(v.aheadLabel).toBeNull();
    expect(v.interestDodged).toBeNull();
  });

  it('projects an earlier payoff WITH the extra than without it', () => {
    const withExtra = paydownView(makeState({ loanFacts: M, homeLoan: { balance: 528000, asOf: null } }), TODAY);
    const noExtra = paydownView(makeState({ loanFacts: { ...M, extra: 0 }, homeLoan: { balance: 528000, asOf: null } }), TODAY);
    // Nov 2042 (with extra) is well before Dec 2046 (scheduled only).
    expect(withExtra.freedomLabel).toBe('Nov 2042');
    expect(noExtra.freedomLabel).toBe('Dec 2046');
  });
});
