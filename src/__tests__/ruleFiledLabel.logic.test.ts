// WHIT-539: unit tests for ruleFiledLabel — the pure helper that turns the rule which
// auto-filed a charge into human text for the transaction detail screen.
import { it, expect, describe } from '@jest/globals';
import { ruleFiledLabel, RULE_FILED_FALLBACK } from '../context';
import type { Rule } from '../context';

function rule(over: Partial<Rule> = {}): Rule {
  return { id: 'r1', pattern: 'COLES', categoryId: 'coffee', isNew: false, field: 'description', operator: 'contains', ...over };
}

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
});
