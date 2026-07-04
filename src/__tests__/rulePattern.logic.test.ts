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

  // WHIT-112: BankSync emits descriptor variants for one merchant. The sweep must
  // span them (normalised match + fuzzy merchant-similarity gate), both directions.
  it('spans BankSync descriptor variants of the same merchant (space vs no-space)', () => {
    const originSun = txn({
      description: 'POS AUTHORISATION         SQ *KKV INTERNATIONAL PTYSunshine     AU',
      merchant_name: 'KKV INTERNATIONAL PTYSunshine',
    });
    const other = txn({
      transaction_id: 't2',
      description: 'SQ *KKV INTERNATIONAL PTY Sunshine',
      merchant_name: 'KKV INTERNATIONAL PTY',
    });
    // tapping either variant sweeps the other (the space in "PTY Sunshine" no longer splits them)
    expect(matchesRulePattern(other, rulePattern(originSun), originSun)).toBe(true);
    expect(matchesRulePattern(originSun, rulePattern(other), other)).toBe(true);
  });

  it('does NOT merge two merchants that only share a short prefix (BP vs BPAY)', () => {
    // The fuzzy score is what stops this: `bp` vs `bpay` scores ~0.50, below the
    // 0.6 threshold, even though "bp" IS a prefix of "bpay" and the description
    // gate passes. A raw prefix rule would wrongly sweep BPAY bills into BP fuel.
    const origin = txn({ description: 'BP 1234 SYDNEY', merchant_name: 'BP' });
    const other = txn({ transaction_id: 't2', description: 'BPAY BILL PAYMENT AGL', merchant_name: 'BPAY' });
    expect(matchesRulePattern(other, rulePattern(origin), origin)).toBe(false);
  });

  it('excludes a coincidental substring when the candidate has a merchant name (Nicole vs Coles)', () => {
    // Stripping punctuation makes "Nicole's" -> "nicoles" (contains "coles"), so the
    // normalised description gate passes — the merchant similarity score must block it.
    const origin = txn({ description: 'COLES 0900', merchant_name: 'Coles' });
    const other = txn({ transaction_id: 't2', description: "NICOLE'S CAFE", merchant_name: "Nicole's Cafe" });
    expect(matchesRulePattern(other, rulePattern(origin), origin)).toBe(false);
  });

  it('excludes a coincidental substring when the candidate has NO merchant name', () => {
    // With no merchant name there's no score to lean on, so the fallback uses a
    // space-preserving description contains: "nicole's cafe" does NOT contain "coles"
    // (the space + apostrophe keep them apart), so it is correctly excluded.
    const origin = txn({ description: 'COLES 0900', merchant_name: 'Coles' });
    const other = txn({ transaction_id: 't2', description: "NICOLE'S CAFE", merchant_name: '' });
    expect(matchesRulePattern(other, rulePattern(origin), origin)).toBe(false);
  });
});
