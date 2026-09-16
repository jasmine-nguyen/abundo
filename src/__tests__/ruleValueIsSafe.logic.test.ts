// WHIT-563 — ruleValueIsSafe is the client mirror of the server's contains-value floor
// (merchant_groups.rule_value_is_safe, which counts characters where str.isalnum() is true and
// requires >= MIN_RULE_VALUE_ALPHANUMERICS). ruleVocabulary.logic.test.ts pins the CONSTANT (4)
// against the server but never exercises the FUNCTION's counting, so this covers:
//   [G6] the count is of unicode letters/digits (\p{L}\p{N}), punctuation/whitespace/emoji excluded.
// Fail-on-revert: change the floor or the character class and these redden.
import { describe, it, expect } from '@jest/globals';
import { ruleValueIsSafe, MIN_RULE_VALUE_ALPHANUMERICS } from '../ruleVocabulary';

describe('ruleValueIsSafe counts letters/digits against the floor', () => {
  it('the floor is 4', () => {
    expect(MIN_RULE_VALUE_ALPHANUMERICS).toBe(4);
  });

  it('accepts exactly four alphanumerics and rejects three', () => {
    expect(ruleValueIsSafe('ABCD')).toBe(true);
    expect(ruleValueIsSafe('ABC')).toBe(false);
    expect(ruleValueIsSafe('1234')).toBe(true);
    expect(ruleValueIsSafe('')).toBe(false);
  });

  it('ignores punctuation and whitespace when counting', () => {
    expect(ruleValueIsSafe('a.b.c')).toBe(false); // 3 letters, dots do not count
    expect(ruleValueIsSafe('  A B C D  ')).toBe(true); // 4 letters, spaces do not count
    expect(ruleValueIsSafe('....')).toBe(false); // no alphanumerics at all
  });

  it('counts unicode letters and digits (matches the server isalnum, which is unicode-aware)', () => {
    expect(ruleValueIsSafe('café')).toBe(true); // c a f é -> 4 unicode letters
    expect(ruleValueIsSafe('caf')).toBe(false);
    expect(ruleValueIsSafe('東京都港')).toBe(true); // 4 CJK letters
  });

  it('rejects emoji-only values (emoji are not letters or digits, matching server isalnum=false)', () => {
    expect(ruleValueIsSafe('🎉🎉🎉🎉')).toBe(false);
  });
});
