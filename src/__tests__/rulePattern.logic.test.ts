// Logic test: rulePattern — the generalised match pattern the "Every {merchant}
// charge" rule uses (WHIT: smart apply-all). Verifies it extracts the merchant
// substring (dropping volatile suffixes), preserves the description's casing, and
// falls back to the full description safely.
import { describe, it, expect } from '@jest/globals';
import { rulePattern, matchesRulePattern } from '../context';
import { txn } from './factory';

describe('rulePattern', () => {
  it('extracts the merchant substring, dropping the volatile store#/location suffix', () => {
    expect(rulePattern(txn({ description: 'WOOLWORTHS METRO 1234 SYDNEY', merchant_name: 'Woolworths' })))
      .toBe('WOOLWORTHS');
  });

  it("preserves the description's casing so a case-sensitive contains still matches", () => {
    expect(rulePattern(txn({ description: 'DD *DOORDASH HUTIEUGOO', merchant_name: 'DoorDash' })))
      .toBe('DOORDASH');
  });

  it('falls back to the full description when the merchant name is not a substring', () => {
    expect(rulePattern(txn({ description: 'SQ *KKV INTERNATIONAL', merchant_name: 'Something Else' })))
      .toBe('SQ *KKV INTERNATIONAL');
  });

  it('falls back to the full description when there is no merchant name', () => {
    expect(rulePattern(txn({ description: 'NETFLIX.COM', merchant_name: '' })))
      .toBe('NETFLIX.COM');
  });
});

describe('matchesRulePattern', () => {
  const origin = txn({ description: 'WOOLWORTHS METRO 1234', merchant_name: 'Woolworths' });
  const pattern = rulePattern(origin); // 'WOOLWORTHS'

  it('matches a same-merchant charge whose description contains the pattern', () => {
    const other = txn({ transaction_id: 't2', description: 'WOOLWORTHS 5678 MELBOURNE', merchant_name: 'Woolworths' });
    expect(matchesRulePattern(other, pattern, origin)).toBe(true);
  });

  it('is case-insensitive on the description contains check', () => {
    const other = txn({ transaction_id: 't2', description: 'woolworths online', merchant_name: 'Woolworths' });
    expect(matchesRulePattern(other, pattern, origin)).toBe(true);
  });

  it('does NOT match a different merchant even if the token appears in its description', () => {
    // "Metro"-style over-match: same substring, different merchant -> excluded.
    const other = txn({ transaction_id: 't2', description: 'WOOLWORTHS METRO PETROL', merchant_name: 'Caltex' });
    expect(matchesRulePattern(other, pattern, origin)).toBe(false);
  });

  it('falls back to the description match when a charge has no merchant name', () => {
    const other = txn({ transaction_id: 't2', description: 'WOOLWORTHS KIOSK', merchant_name: '' });
    expect(matchesRulePattern(other, pattern, origin)).toBe(true);
  });

  it('excludes a charge whose description does not contain the pattern', () => {
    const other = txn({ transaction_id: 't2', description: 'COLES 900', merchant_name: 'Woolworths' });
    expect(matchesRulePattern(other, pattern, origin)).toBe(false);
  });

  it('empty pattern falls back to exact description equality', () => {
    const a = txn({ transaction_id: 't2', description: '', merchant_name: '' });
    const b = txn({ transaction_id: 't3', description: '', merchant_name: '' });
    const c = txn({ transaction_id: 't4', description: 'SOMETHING', merchant_name: '' });
    expect(matchesRulePattern(a, '', b)).toBe(true);   // both empty desc -> equal
    expect(matchesRulePattern(c, '', b)).toBe(false);  // not equal -> excluded
  });
});
