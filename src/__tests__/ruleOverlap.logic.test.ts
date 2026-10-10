// WHIT-562: ruleOverlap is the pre-save "would these two rules fight?" guard for MULTI-CONDITION
// rules. It warns (the builder soft-warns, never blocks) when a candidate rule can co-match a charge
// with an existing rule that files to a DIFFERENT category — those charges sit unfiled (the server's
// `decide` marks them conflicted, WHIT-355). CONSERVATIVE by design: it fires only on a PROVABLE
// overlap (text by containment, amount by interval intersection), so it never false-blocks.
import { describe, it, expect } from '@jest/globals';
import { ruleOverlap } from '../context';
import type { Rule } from '../model';
import type { RuleCondition, RuleLogic } from '../api';

const classic = (id: string, pattern: string, categoryId: string): Rule =>
  ({ id, pattern, categoryId, isNew: false });

const multi = (id: string, categoryId: string, conditions: RuleCondition[], logic: RuleLogic = 'all'): Rule =>
  ({ id, pattern: conditions[0].value, categoryId, isNew: false, conditions, logic });

const c = (field: string, operator: string, value: string): RuleCondition => ({ field, operator, value });

const overlapKind = (result: ReturnType<typeof ruleOverlap>) => result?.kind;

describe('ruleOverlap — text (containment)', () => {
  it('flags the motivating case: COLES AND under $40 (dining) vs COLES (groceries)', () => {
    const existing = classic('g', 'COLES', 'groceries');
    const candidate = [c('description', 'contains', 'COLES'), c('amount', 'less_than', '40')];
    expect(ruleOverlap([existing], candidate, 'all', 'dining'))
      .toEqual({ kind: 'overlap', existing });
  });

  it('does NOT flag non-nested text (COLES vs WOOLIES) — the quiet, conservative choice', () => {
    const existing = classic('g', 'WOOLIES', 'groceries');
    expect(ruleOverlap([existing], [c('description', 'contains', 'COLES')], 'all', 'dining')).toBeNull();
  });

  it('flags nested text: candidate "COLES EXPRESS" vs existing "COLES"', () => {
    const existing = classic('g', 'COLES', 'groceries');
    expect(overlapKind(ruleOverlap([existing], [c('description', 'contains', 'COLES EXPRESS')], 'all', 'dining')))
      .toBe('overlap');
  });

  it('matches case- and space-insensitively (mirrors the engine _normalise)', () => {
    const existing = classic('g', 'coles', 'groceries');
    expect(overlapKind(ruleOverlap([existing], [c('description', 'contains', '  COLES  ')], 'all', 'dining')))
      .toBe('overlap');
  });

  it('treats description and merchant as the same charge text', () => {
    const existing = multi('m', 'groceries', [c('merchant', 'contains', 'COLES')]);
    expect(overlapKind(ruleOverlap([existing], [c('description', 'contains', 'COLES')], 'all', 'dining')))
      .toBe('overlap');
  });

  it('an equals rule co-matches only a contains substring of it', () => {
    // candidate `description equals COLES` co-matches existing `contains COLE` (the exact string COLES contains COLE)
    const existingContains = multi('e', 'groceries', [c('description', 'contains', 'COLE')]);
    expect(overlapKind(ruleOverlap([existingContains], [c('description', 'equals', 'COLES')], 'all', 'dining')))
      .toBe('overlap');
    // but not existing `equals WOOLIES` (two different exact strings can't both be the charge)
    const existingEquals = multi('e2', 'groceries', [c('description', 'equals', 'WOOLIES')]);
    expect(ruleOverlap([existingEquals], [c('description', 'equals', 'COLES')], 'all', 'dining')).toBeNull();
  });
});

describe('ruleOverlap — amount intervals', () => {
  const groceries = classic('g', 'COLES', 'groceries');
  const withAmount = (op: string, v: string) => [c('description', 'contains', 'COLES'), c('amount', op, v)];

  it('flags overlapping bands (<40 vs a plain COLES rule that has no amount)', () => {
    expect(overlapKind(ruleOverlap([groceries], withAmount('less_than', '40'), 'all', 'dining'))).toBe('overlap');
  });

  it('does NOT flag disjoint bands: candidate <20 vs existing COLES AND >40', () => {
    const existing = multi('g2', 'groceries', [c('description', 'contains', 'COLES'), c('amount', 'greater_than', '40')]);
    expect(ruleOverlap([existing], withAmount('less_than', '20'), 'all', 'dining')).toBeNull();
  });

  it('flags touching-but-overlapping bands: candidate <=40 vs existing >=40 (meet at 40)', () => {
    const existing = multi('g2', 'groceries', [c('description', 'contains', 'COLES'), c('amount', 'greater_than_or_equal', '40')]);
    expect(overlapKind(ruleOverlap([existing], withAmount('less_than_or_equal', '40'), 'all', 'dining'))).toBe('overlap');
  });

  it('does NOT flag exclusive boundary: candidate <40 vs existing >=40 (empty at 40)', () => {
    const existing = multi('g2', 'groceries', [c('description', 'contains', 'COLES'), c('amount', 'greater_than_or_equal', '40')]);
    expect(ruleOverlap([existing], withAmount('less_than', '40'), 'all', 'dining')).toBeNull();
  });
});

describe('ruleOverlap — direction / account', () => {
  it('flags same direction (debit vs debit), different category', () => {
    const existing = multi('g', 'groceries', [c('description', 'contains', 'COLES'), c('direction', 'is', 'debit')]);
    const candidate = [c('description', 'contains', 'COLES'), c('direction', 'is', 'debit')];
    expect(overlapKind(ruleOverlap([existing], candidate, 'all', 'dining'))).toBe('overlap');
  });

  it('does NOT flag opposite directions (debit vs credit)', () => {
    const existing = multi('g', 'groceries', [c('description', 'contains', 'COLES'), c('direction', 'is', 'credit')]);
    const candidate = [c('description', 'contains', 'COLES'), c('direction', 'is', 'debit')];
    expect(ruleOverlap([existing], candidate, 'all', 'dining')).toBeNull();
  });

  it('does NOT flag different accounts', () => {
    const existing = multi('g', 'groceries', [c('account', 'equals', 'acc-1')]);
    expect(ruleOverlap([existing], [c('account', 'equals', 'acc-2')], 'all', 'dining')).toBeNull();
  });
});

describe('ruleOverlap — OR logic', () => {
  it('flags via a disjunct: candidate [COLES OR amount<40] vs existing WOOLIES', () => {
    // WOOLIES itself doesn't overlap COLES, but a $20 WOOLIES charge matches the amount<40 disjunct.
    const existing = classic('g', 'WOOLIES', 'groceries');
    const candidate = [c('description', 'contains', 'COLES'), c('amount', 'less_than', '40')];
    expect(overlapKind(ruleOverlap([existing], candidate, 'any', 'dining'))).toBe('overlap');
  });

  it('existing OR rule: any of its disjuncts overlapping the candidate flags it', () => {
    const existing = multi('g', 'groceries', [c('description', 'contains', 'ALDI'), c('description', 'contains', 'COLES')], 'any');
    expect(overlapKind(ruleOverlap([existing], [c('description', 'contains', 'COLES')], 'all', 'dining'))).toBe('overlap');
  });
});

describe('ruleOverlap — gating', () => {
  it('returns null when the existing rule files to the SAME category (they agree)', () => {
    const existing = classic('g', 'COLES', 'dining');
    expect(ruleOverlap([existing], [c('description', 'contains', 'COLES')], 'all', 'dining')).toBeNull();
  });

  it('excludes the rule being edited (a rule never overlaps itself)', () => {
    const self = multi('self', 'dining', [c('description', 'contains', 'COLES'), c('amount', 'less_than', '40')]);
    expect(ruleOverlap([self], [c('description', 'contains', 'COLES')], 'all', 'groceries', 'self')).toBeNull();
  });
});

describe('ruleOverlap — edges that mirror the engine (shared/rule_engine.py)', () => {
  it('does NOT flag AND[contains ALDI, contains COLES] vs an ALDI rule (no value is a superstring)', () => {
    const existing = classic('g', 'ALDI', 'groceries');
    const candidate = [c('description', 'contains', 'ALDI'), c('description', 'contains', 'COLES')];
    expect(ruleOverlap([existing], candidate, 'all', 'dining')).toBeNull();
  });

  it('does NOT flag when text overlaps but ACCOUNTS differ [A21]', () => {
    const existing = multi('g', 'groceries', [c('description', 'contains', 'COLES'), c('account', 'equals', 'acc-2')]);
    const candidate = [c('description', 'contains', 'COLES'), c('account', 'equals', 'acc-1')];
    expect(ruleOverlap([existing], candidate, 'all', 'dining')).toBeNull();
  });

  // Mirror _amount_matches fail-closed: a threshold the engine can't use matches nothing.
  it.each([
    ['a non-numeric threshold — the engine matches nothing [A25]', 'less_than', 'abc', undefined],
    ['a negative less_than threshold (magnitude is never < -5) [A26]', 'less_than', '-5', undefined],
    ['less_than 0 (empty magnitude interval) [A27]', 'less_than', '0', undefined],
    ['greater_than a negative value — magnitude>=0 always clears it, so bands still overlap [A28]', 'greater_than', '-5', 'overlap'],
    ['a BLANK threshold — Number("") is 0 but the engine Decimal("") matches nothing [A26b]', 'greater_than', '', undefined],
  ])('unusable or empty amount thresholds: %s', (_name, op, value, expected) => {
    const coles = classic('g', 'COLES', 'groceries');
    const candidate = [c('description', 'contains', 'COLES'), c('amount', op, value)];
    expect(overlapKind(ruleOverlap([coles], candidate, 'all', 'dining'))).toBe(expected);
  });

  it('does NOT flag "COLES  ONLINE" (two spaces) vs "COLES ONLINE" (one space)', () => {
    const existing = multi('g', 'groceries', [c('description', 'contains', 'COLES ONLINE')]);
    const candidate = [c('description', 'contains', 'COLES  ONLINE')];
    expect(ruleOverlap([existing], candidate, 'all', 'dining')).toBeNull();
  });

  // The engine's _condition_matches returns False for a (field, operator) it can't evaluate, so the
  // clause can never match. Without the guard the bad condition is silently dropped and falsely overlaps.
  it.each([
    ['does NOT flag against an existing rule carrying an unsupported FIELD [A33]', [c('note', 'contains', 'COLES')]],
    ['does NOT flag a known field with an unsupported OPERATOR [A33b]', [c('description', 'contains', 'COLES'), c('description', 'less_than', '5')]],
  ])('%s', (_name, conditions) => {
    const existing = multi('g', 'groceries', conditions);
    expect(ruleOverlap([existing], [c('description', 'contains', 'COLES')], 'all', 'dining')).toBeNull();
  });
});
