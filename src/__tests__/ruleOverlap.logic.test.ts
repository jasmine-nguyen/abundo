// WHIT-562: ruleOverlap is the pre-save "would these two rules fight?" guard for MULTI-CONDITION
// rules. It warns (the builder soft-warns, never blocks) when a candidate rule can co-match a charge
// with an existing rule that files to a DIFFERENT category — those charges sit unfiled (the server's
// `decide` marks them conflicted, WHIT-355). CONSERVATIVE by design: it fires only on a PROVABLE
// overlap (text by containment, amount by interval intersection), so it never false-blocks.
import { describe, it, expect } from '@jest/globals';
import { ruleOverlap, type Rule } from '../context';
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
    const exact = classic('g', 'COLES', 'groceries');
    // candidate `description equals COLES` co-matches existing `contains COLE` (the exact string COLES contains COLE)
    const existingContains = multi('e', 'groceries', [c('description', 'contains', 'COLE')]);
    expect(overlapKind(ruleOverlap([existingContains], [c('description', 'equals', 'COLES')], 'all', 'dining')))
      .toBe('overlap');
    // but not existing `equals WOOLIES` (two different exact strings can't both be the charge)
    void exact;
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

  it('returns the FIRST fighting rule when several overlap', () => {
    const a = classic('a', 'COLES', 'groceries');
    const b = classic('b', 'COLES', 'transport');
    expect(ruleOverlap([a, b], [c('description', 'contains', 'COLES')], 'all', 'dining')?.existing.id).toBe('a');
  });

  it('returns null against an empty rule list', () => {
    expect(ruleOverlap([], [c('description', 'contains', 'COLES')], 'all', 'dining')).toBeNull();
  });
});
