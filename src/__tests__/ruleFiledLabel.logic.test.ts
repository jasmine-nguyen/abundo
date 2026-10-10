// WHIT-539: unit tests for ruleFiledLabel — the pure helper that turns the rule which
// auto-filed a charge into human text for the transaction detail screen.
import { it, expect, describe } from '@jest/globals';
import { ruleFiledLabel, RULE_FILED_FALLBACK } from '../context';
import { rule } from './factory';

describe('ruleFiledLabel', () => {
  it.each([
    ['a description/contains rule reads "contains \\"VALUE\\""', 'contains', 'COLES', 'contains "COLES"'],
    ['honours a non-default operator (description/equals)', 'equals', 'COLES ONLINE', 'equals "COLES ONLINE"'],
    ['defaults a missing operator to "contains" (app-authored rule)', undefined, 'COLES', 'contains "COLES"'],
  ])('%s', (_name, operator, pattern, quoted) => {
    expect(ruleFiledLabel(rule({ operator, pattern }))).toBe(`Filed by your rule: ${quoted}`);
  });

  // Fail-on-revert (MAJOR-2): a category rule's pattern is a raw enum, so it must NOT be echoed.
  it('a category rule falls back to the generic line, never echoing the raw enum', () => {
    const label = ruleFiledLabel(rule({ field: 'category', operator: 'equals', pattern: 'FOOD_AND_DRINK' }));
    expect(label).toBe(RULE_FILED_FALLBACK);
    expect(label).not.toContain('FOOD_AND_DRINK');
  });

  // Fail-on-revert (QA #3): a blank/whitespace pattern is a malformed rule with nothing to quote —
  // fall back rather than render `contains ""`. Dropping the pattern guard shows empty quotes.
  it('a blank pattern falls back to the generic line (never empty quotes)', () => {
    expect(ruleFiledLabel(rule({ field: 'description', operator: 'contains', pattern: '   ' }))).toBe(RULE_FILED_FALLBACK);
  });
});
