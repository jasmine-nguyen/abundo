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

  it('flags a partial payload (amount XOR date) as malformed, not genuinely empty (WHIT-121)', () => {
    // A server that sent SOME field but not the amount+date pair we render → malformed (an
    // error the card surfaces), distinct from all-null which is a genuine "none on record".
    expect(lastRepaymentView(makeState({ repayment: { amount: 1440, date: null, principal: null, interest: null } })).malformed).toBe(true);
    expect(lastRepaymentView(makeState({ repayment: { amount: null, date: '2026-07-01', principal: null, interest: null } })).malformed).toBe(true);
    // All-null is genuinely empty (not malformed); a fully-present repayment is not malformed.
    expect(lastRepaymentView(makeState({ repayment: NO_REPAYMENT })).malformed).toBe(false);
    expect(lastRepaymentView(makeState({ repayment: REPAYMENT })).malformed).toBe(false);
  });

  // WHIT-121 boundary: `malformed` keys ONLY on the amount+date pair, never on the split
  // legs. A fully-usable repayment (amount+date present) with a HALF split (principal set,
  // interest null) is present:true / malformed:false — it renders the REAL card (total-only),
  // NOT the error branch. Confirms a half-split isn't mistaken for a half-payment.
  it('does NOT flag a half-split (amount+date present, interest null) as malformed (WHIT-121)', () => {
    const v = lastRepaymentView(makeState({ repayment: { amount: 1440, date: '2026-07-01', principal: 1208, interest: null } }));
    expect(v.present).toBe(true);
    expect(v.malformed).toBe(false);
    expect(v.splitLabel).toBeNull(); // never a fabricated split from a lone leg
  });
});
