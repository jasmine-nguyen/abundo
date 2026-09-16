// WHIT-562 — ADVERSARIAL GAPS for ruleOverlap (the pre-save "would two multi rules fight?" guard).
// Complements src/__tests__/ruleOverlap.logic.test.ts (motivating case, single-bucket amount/text/
// direction/account, OR-vs-classic, gating) — here we hit the cross-bucket, OR-vs-OR, edit-toggle,
// numeric-edge and _normalise-whitespace corners it leaves open. Every assertion mirrors what the
// real engine (shared/rule_engine.py) would do, so a false flag or a missed provable overlap fails.
import { describe, it, expect } from '@jest/globals';
import { ruleOverlap, type Rule } from '../context';
import type { RuleCondition, RuleLogic } from '../api';

const classic = (id: string, pattern: string, categoryId: string): Rule =>
  ({ id, pattern, categoryId, isNew: false });
const multi = (id: string, categoryId: string, conditions: RuleCondition[], logic: RuleLogic = 'all'): Rule =>
  ({ id, pattern: conditions[0].value, categoryId, isNew: false, conditions, logic });
const c = (field: string, operator: string, value: string): RuleCondition => ({ field, operator, value });
const kind = (r: ReturnType<typeof ruleOverlap>) => r?.kind;

describe('ruleOverlap — text containment: multi-contains with no superstring [A20]', () => {
  it('does NOT flag AND[contains ALDI, contains COLES] vs an ALDI rule (no value is a superstring)', () => {
    const existing = classic('g', 'ALDI', 'groceries');
    const candidate = [c('description', 'contains', 'ALDI'), c('description', 'contains', 'COLES')];
    expect(ruleOverlap([existing], candidate, 'all', 'dining')).toBeNull();
  });
  it('flags equals-vs-equals on the SAME folded value (both pin the charge to one string)', () => {
    const existing = multi('e', 'groceries', [c('description', 'equals', 'COLES')]);
    expect(kind(ruleOverlap([existing], [c('description', 'equals', 'coles')], 'all', 'dining'))).toBe('overlap');
  });
});

describe('ruleOverlap — mixed AND clause: one bucket UNSAT sinks the whole clause', () => {
  it('does NOT flag when text overlaps but ACCOUNTS differ [A21]', () => {
    const existing = multi('g', 'groceries', [c('description', 'contains', 'COLES'), c('account', 'equals', 'acc-2')]);
    const candidate = [c('description', 'contains', 'COLES'), c('account', 'equals', 'acc-1')];
    expect(ruleOverlap([existing], candidate, 'all', 'dining')).toBeNull();
  });
  it('flags when text overlaps AND accounts agree [A22]', () => {
    const existing = multi('g', 'groceries', [c('description', 'contains', 'COLES'), c('account', 'equals', 'acc-1')]);
    const candidate = [c('description', 'contains', 'COLES'), c('account', 'equals', 'acc-1')];
    expect(kind(ruleOverlap([existing], candidate, 'all', 'dining'))).toBe('overlap');
  });
});

describe('ruleOverlap — OR-vs-OR cross product [A23]', () => {
  it('flags when one disjunct of each rule overlaps (ALDI × ALDI)', () => {
    const existing = multi('g', 'groceries', [c('description', 'contains', 'WOOLIES'), c('description', 'contains', 'ALDI')], 'any');
    const candidate = [c('description', 'contains', 'COLES'), c('description', 'contains', 'ALDI')];
    expect(kind(ruleOverlap([existing], candidate, 'any', 'dining'))).toBe('overlap');
  });
  it('does NOT flag when no disjunct pair overlaps [A24]', () => {
    const existing = multi('g', 'groceries', [c('description', 'contains', 'WOOLIES'), c('description', 'contains', 'BAKERY')], 'any');
    const candidate = [c('description', 'contains', 'COLES'), c('description', 'contains', 'ALDI')];
    expect(ruleOverlap([existing], candidate, 'any', 'dining')).toBeNull();
  });
});

describe('ruleOverlap — amount numeric edges (mirror _amount_matches fail-closed)', () => {
  const coles = classic('g', 'COLES', 'groceries');
  const withAmt = (op: string, v: string) => [c('description', 'contains', 'COLES'), c('amount', op, v)];
  it('does NOT flag a non-numeric threshold — the engine matches nothing [A25]', () => {
    expect(ruleOverlap([coles], withAmt('less_than', 'abc'), 'all', 'dining')).toBeNull();
  });
  it('does NOT flag a negative less_than threshold (magnitude is never < -5) [A26]', () => {
    expect(ruleOverlap([coles], withAmt('less_than', '-5'), 'all', 'dining')).toBeNull();
  });
  it('does NOT flag less_than 0 (empty magnitude interval) [A27]', () => {
    expect(ruleOverlap([coles], withAmt('less_than', '0'), 'all', 'dining')).toBeNull();
  });
  it('flags greater_than a negative value — magnitude>=0 always clears it, so bands still overlap [A28]', () => {
    expect(kind(ruleOverlap([coles], withAmt('greater_than', '-5'), 'all', 'dining'))).toBe('overlap');
  });
  it('does NOT flag a BLANK threshold — Number("") is 0 but the engine Decimal("") matches nothing [A26b]', () => {
    // Fail-on-revert for the blank-amount guard: without it, greater_than "" folds to > 0 and falsely overlaps.
    expect(ruleOverlap([coles], withAmt('greater_than', ''), 'all', 'dining')).toBeNull();
  });
});

describe('ruleOverlap — direction + amount interaction', () => {
  it('flags same direction with overlapping amount bands [A29]', () => {
    const existing = multi('g', 'groceries', [c('direction', 'is', 'debit'), c('amount', 'less_than', '50')]);
    const candidate = [c('direction', 'is', 'debit'), c('amount', 'less_than', '40')];
    expect(kind(ruleOverlap([existing], candidate, 'all', 'dining'))).toBe('overlap');
  });
  it('does NOT flag same direction when amount bands are disjoint [A30]', () => {
    const existing = multi('g', 'groceries', [c('direction', 'is', 'debit'), c('amount', 'greater_than', '40')]);
    const candidate = [c('direction', 'is', 'debit'), c('amount', 'less_than', '40')];
    expect(ruleOverlap([existing], candidate, 'all', 'dining')).toBeNull();
  });
});

describe('ruleOverlap — _normalise whitespace is NOT collapsed [A31]', () => {
  it('does NOT flag "COLES  ONLINE" (two spaces) vs "COLES ONLINE" (one space)', () => {
    const existing = multi('g', 'groceries', [c('description', 'contains', 'COLES ONLINE')]);
    const candidate = [c('description', 'contains', 'COLES  ONLINE')];
    expect(ruleOverlap([existing], candidate, 'all', 'dining')).toBeNull();
  });
  it('DOES flag identical internal spacing regardless of surrounding whitespace/case', () => {
    const existing = multi('g', 'groceries', [c('description', 'contains', 'coles online')]);
    const candidate = [c('description', 'contains', '  COLES ONLINE  ')];
    expect(kind(ruleOverlap([existing], candidate, 'all', 'dining'))).toBe('overlap');
  });
});

describe('ruleOverlap — editing toggles the warning [A32]', () => {
  const other = classic('other', 'COLES', 'groceries');
  const editingRule = multi('self', 'dining', [c('description', 'contains', 'COLES')]);
  it('editing a rule to a category that still differs from a sibling KEEPS the warning (self excluded)', () => {
    const result = ruleOverlap([editingRule, other], [c('description', 'contains', 'COLES')], 'all', 'transport', 'self');
    expect(result?.existing.id).toBe('other');
  });
  it('editing that rule to MATCH the sibling category clears the warning', () => {
    const result = ruleOverlap([editingRule, other], [c('description', 'contains', 'COLES')], 'all', 'groceries', 'self');
    expect(result).toBeNull();
  });
});

describe('ruleOverlap — an (field, operator) the engine cannot evaluate never co-matches', () => {
  it('does NOT flag against an existing rule carrying an unsupported FIELD [A33]', () => {
    const existing = multi('g', 'groceries', [c('note', 'contains', 'COLES')]);
    expect(ruleOverlap([existing], [c('description', 'contains', 'COLES')], 'all', 'dining')).toBeNull();
  });
  it('does NOT flag a known field with an unsupported OPERATOR [A33b]', () => {
    // Fail-on-revert for the central (field, operator) guard: `description less_than 5` is not a real
    // rule, but the engine's _condition_matches returns False for it, so the clause can never match.
    // Without the guard the bad-operator condition is silently dropped and the rule falsely overlaps.
    const existing = multi('g', 'groceries', [c('description', 'contains', 'COLES'), c('description', 'less_than', '5')]);
    expect(ruleOverlap([existing], [c('description', 'contains', 'COLES')], 'all', 'dining')).toBeNull();
  });
});
