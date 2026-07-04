// WHIT-115 — adversarial GAP tests for lastRepaymentView (does NOT duplicate
// repayment.logic.test.ts, which locks split / total-only / empty / lone-amount).
// Covers: deterministic whenLabel formatting (the base test only asserts non-''),
// the amount===0 boundary, and the both-or-nothing split from the OTHER side
// (exactly one of principal/interest present must still suppress the split).
import { describe, it, expect } from '@jest/globals';
import { lastRepaymentView } from '../context';
import { makeState } from './factory';

describe('lastRepaymentView — edges', () => {
  it('formats whenLabel as "Wkd D Mon" for a past date (weekday derived from the date)', () => {
    // 2020-01-15 is a Wednesday and is far from any run date, so it never hits the
    // relative Today/Yesterday branch — the label is fully deterministic.
    const v = lastRepaymentView(makeState({ repayment: { amount: 1440, date: '2020-01-15', principal: null, interest: null } }));
    expect(v.whenLabel).toBe('Wed 15 Jan');
  });

  it('treats amount === 0 as present (0 is not the null sentinel) and labels it "$0"', () => {
    const v = lastRepaymentView(makeState({ repayment: { amount: 0, date: '2020-01-15', principal: null, interest: null } }));
    expect(v.present).toBe(true);
    expect(v.amountLabel).toBe('$0');
    expect(v.splitLabel).toBeNull();
  });

  it('suppresses the split when only principal is present (interest null)', () => {
    const v = lastRepaymentView(makeState({ repayment: { amount: 1440, date: '2020-01-15', principal: 1208, interest: null } }));
    expect(v.present).toBe(true);
    expect(v.splitLabel).toBeNull();
  });

  it('suppresses the split when only interest is present (principal null)', () => {
    const v = lastRepaymentView(makeState({ repayment: { amount: 1440, date: '2020-01-15', principal: null, interest: 232 } }));
    expect(v.splitLabel).toBeNull();
  });
});
