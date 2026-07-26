// WHIT-355: ruleConflict detects a new/edited rule pattern that clashes with an existing rule.
// duplicate = same pattern + same category (no-op); conflict = same pattern + different category.
// Identity is case/whitespace-insensitive but space-PRESERVING (a rule matches a raw
// `description contains value`), so near-duplicates are intentionally NOT flagged.
import { describe, it, expect } from '@jest/globals';
import { ruleConflict, type Rule } from '../context';

const rule = (id: string, pattern: string, categoryId: string): Rule =>
  ({ id, pattern, categoryId, isNew: false });

const NETFLIX = rule('b1', 'NETFLIX', 'subs');
const WELLBEING = rule('b2', 'WELLBEING SERVICES PTY ST ALBA', 'health');

describe('ruleConflict', () => {
  it('flags an exact duplicate (same pattern, same category)', () => {
    expect(ruleConflict([NETFLIX], 'NETFLIX', 'subs')).toEqual({ kind: 'duplicate', existing: NETFLIX });
  });

  it('flags a conflict (same pattern, different category) — the WELLBEING Health-vs-Fitness case', () => {
    expect(ruleConflict([WELLBEING], 'WELLBEING SERVICES PTY ST ALBA', 'fitness'))
      .toEqual({ kind: 'conflict', existing: WELLBEING });
  });

  it('returns null when no existing rule shares the pattern', () => {
    expect(ruleConflict([NETFLIX], 'SPOTIFY', 'subs')).toBeNull();
  });

  it('matches case-insensitively', () => {
    expect(ruleConflict([NETFLIX], 'netflix', 'subs')?.kind).toBe('duplicate');
  });

  it('folds surrounding and internal whitespace', () => {
    const kkv = rule('b3', 'KKV INTERNATIONAL PTY', 'coffee');
    expect(ruleConflict([kkv], '  kkv   international    pty  ', 'coffee')?.kind).toBe('duplicate');
  });

  it('excludes the rule being edited (a rule never conflicts with itself)', () => {
    expect(ruleConflict([NETFLIX], 'NETFLIX', 'subs', 'b1')).toBeNull();
  });

  it('detects an edit-into-collision: editing one rule to match another returns that other rule', () => {
    const rules = [rule('e1', 'OLD', 'subs'), NETFLIX];
    // Editing e1's pattern to "NETFLIX" clashes with b1 (NETFLIX), which is returned, not e1.
    expect(ruleConflict(rules, 'NETFLIX', 'subs', 'e1')).toEqual({ kind: 'duplicate', existing: NETFLIX });
  });

  it('does NOT flag a near-duplicate that would match different descriptions (by design)', () => {
    // Space-stripping would wrongly merge these; space-preserving identity keeps them distinct.
    expect(ruleConflict([WELLBEING], 'WELLBEINGSERVICESPTYSTALBA', 'health')).toBeNull();
    expect(ruleConflict([rule('b4', 'KKV INTERNATIONAL PTY', 'coffee')], 'KKV', 'coffee')).toBeNull();
  });

  it('returns null for an empty or whitespace-only pattern', () => {
    expect(ruleConflict([NETFLIX], '', 'subs')).toBeNull();
    expect(ruleConflict([NETFLIX], '   ', 'subs')).toBeNull();
  });

  it('returns the FIRST matching rule when several share the pattern', () => {
    const a = rule('a', 'DUP', 'subs');
    const b = rule('b', 'DUP', 'coffee');
    expect(ruleConflict([a, b], 'DUP', 'groceries')?.existing.id).toBe('a');
  });
});
