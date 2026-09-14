// WHIT-539: unit tests for ruleFiledLabel — the pure helper that turns the rule which
// auto-filed a charge into human text for the transaction detail screen.
import { it, expect, describe } from '@jest/globals';
import { ruleFiledLabel, RULE_FILED_FALLBACK } from '../context';
import { rule } from './factory';

describe('ruleFiledLabel', () => {
  it('a description/contains rule reads "contains \\"VALUE\\""', () => {
    expect(ruleFiledLabel(rule({ operator: 'contains', pattern: 'COLES' }))).toBe('Filed by your rule: contains "COLES"');
  });

  it('honours a non-default operator (description/equals)', () => {
    expect(ruleFiledLabel(rule({ operator: 'equals', pattern: 'COLES ONLINE' }))).toBe('Filed by your rule: equals "COLES ONLINE"');
  });

  it('defaults a missing operator to "contains" (app-authored rule)', () => {
    expect(ruleFiledLabel(rule({ operator: undefined, pattern: 'COLES' }))).toBe('Filed by your rule: contains "COLES"');
  });

  // Fail-on-revert (MAJOR-2): a category rule's pattern is a raw enum, so it must NOT be echoed.
  it('a category rule falls back to the generic line, never echoing the raw enum', () => {
    const label = ruleFiledLabel(rule({ field: 'category', operator: 'equals', pattern: 'FOOD_AND_DRINK' }));
    expect(label).toBe(RULE_FILED_FALLBACK);
    expect(label).not.toContain('FOOD_AND_DRINK');
  });

  // [G1] Fail-on-revert: the fallback gate is specifically field==='category'. A non-description,
  // non-category field (e.g. a BankSync merchant_name rule) carries HUMAN text, so it names the
  // pattern. Widening the gate to `field !== 'description'` would wrongly hide this pattern.
  it('a non-category, non-description field still names the pattern (not the generic line)', () => {
    const label = ruleFiledLabel(rule({ field: 'merchant_name', operator: 'contains', pattern: 'COLES' }));
    expect(label).toBe('Filed by your rule: contains "COLES"');
    expect(label).not.toBe(RULE_FILED_FALLBACK);
  });

  // [G2] An undefined field (an older stamp) is not the category branch → names the pattern.
  it('an undefined field names the pattern (defaults through the description arm)', () => {
    expect(ruleFiledLabel(rule({ field: undefined, operator: 'contains', pattern: 'COLES' })))
      .toBe('Filed by your rule: contains "COLES"');
  });

  // Fail-on-revert (QA #3): a blank/whitespace pattern is a malformed rule with nothing to quote —
  // fall back rather than render `contains ""`. Dropping the pattern guard shows empty quotes.
  it('a blank pattern falls back to the generic line (never empty quotes)', () => {
    expect(ruleFiledLabel(rule({ field: 'description', operator: 'contains', pattern: '   ' }))).toBe(RULE_FILED_FALLBACK);
  });
});
