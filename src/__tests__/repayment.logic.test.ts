// Logic tests for lastRepaymentView (WHIT-115): the Goal-tab "last repayment"
// card, pure over s.repayment (server-derived). Covers the present-with-split,
// present-total-only, and empty states.
import { describe, it, expect } from '@jest/globals';
import { lastRepaymentView } from '../context';
import { makeState, REPAYMENT, NO_REPAYMENT } from './factory';

describe('lastRepaymentView', () => {
  it('formats a repayment with a paired principal/interest split', () => {
    const v = lastRepaymentView(makeState({ repayment: REPAYMENT }));
    expect(v.present).toBe(true);
    expect(v.amountLabel).toBe('$1,440');
    expect(v.splitLabel).toBe('$1,208 principal · $232 interest');
    expect(v.whenLabel).not.toBe('');   // dateLabel formatted the date
  });

  it('shows total-only (null splitLabel) when the interest leg was not paired', () => {
    const v = lastRepaymentView(makeState({ repayment: { amount: 1440, date: '2026-07-01', principal: null, interest: null } }));
    expect(v.present).toBe(true);
    expect(v.amountLabel).toBe('$1,440');
    expect(v.splitLabel).toBeNull();   // never a fabricated split
  });

  it('is empty when there is no repayment on record', () => {
    const v = lastRepaymentView(makeState({ repayment: NO_REPAYMENT }));
    expect(v.present).toBe(false);
    expect(v.amountLabel).toBe('');
    expect(v.whenLabel).toBe('');
    expect(v.splitLabel).toBeNull();
  });

  it('requires BOTH amount and date to be present (a lone amount is still empty)', () => {
    const v = lastRepaymentView(makeState({ repayment: { amount: 1440, date: null, principal: null, interest: null } }));
    expect(v.present).toBe(false);
  });
});
