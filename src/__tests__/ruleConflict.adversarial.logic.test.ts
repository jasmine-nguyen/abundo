// WHIT-355 (adversarial gaps) — ruleConflict dup-vs-conflict choice under case/whitespace
// differences, empty rule list, and an in-flight optimistic tmp- rule. Complements the
// implementer's ruleConflict.logic.test.ts (which only covers case/whitespace folding for
// the SAME-category duplicate path — never the differing-category conflict path).
import { describe, it, expect } from '@jest/globals';
import { ruleConflict, type Rule } from '../context';

const rule = (id: string, pattern: string, categoryId: string): Rule =>
  ({ id, pattern, categoryId, isNew: false });

describe('ruleConflict — dup vs conflict is chosen on the FOLDED identity, not the raw text', () => {
  // [A-L1] Existing "netflix"/subs, new "NETFLIX"/groceries: identity-equal (case-folded) but
  // categories differ -> must be a CONFLICT, not swallowed as a duplicate. The implementer only
  // proved case-fold -> duplicate; this proves the fold still routes to the conflict branch.
  it('a case-only difference with a DIFFERENT category is a conflict', () => {
    const existing = rule('b1', 'netflix', 'subs');
    expect(ruleConflict([existing], 'NETFLIX', 'groceries')).toEqual({ kind: 'conflict', existing });
  });

  // [A-L2] Same, but the identity match comes from internal-whitespace collapse.
  it('an internal-whitespace-only difference with a DIFFERENT category is a conflict', () => {
    const existing = rule('b1', 'KKV  INTERNATIONAL   PTY', 'coffee');
    expect(ruleConflict([existing], 'kkv international pty', 'groceries'))
      .toEqual({ kind: 'conflict', existing });
  });

  // [A-L3] Same folded pattern AND same category via case/space fold -> duplicate (no-op re-add).
  it('a case+whitespace difference with the SAME category is a duplicate', () => {
    const existing = rule('b1', 'netflix', 'subs');
    expect(ruleConflict([existing], '  NETFLIX ', 'subs')).toEqual({ kind: 'duplicate', existing });
  });
});

describe('ruleConflict — empty and in-flight lists', () => {
  // [A-L4] No rules at all -> never warns (the very-first rule of the session must save clean).
  it('returns null for an empty rules list', () => {
    expect(ruleConflict([], 'NETFLIX', 'subs')).toBeNull();
    expect(ruleConflict([], 'NETFLIX', 'subs', 'e1')).toBeNull();
  });

  // [A-L5] A prior create is still in flight, so its optimistic `tmp-` row (isNew:true) sits in
  // `rules`. It is a real pending rule, so a second identical add MUST still be caught against it
  // (not silently minted as a duplicate row). Documents that tmp- rows are NOT excluded.
  it('an optimistic tmp- rule from an in-flight create is still matched', () => {
    const inFlight: Rule = { id: 'tmp-1730000000000', pattern: 'NETFLIX', categoryId: 'subs', isNew: true };
    expect(ruleConflict([inFlight], 'NETFLIX', 'subs')).toEqual({ kind: 'duplicate', existing: inFlight });
    expect(ruleConflict([inFlight], 'NETFLIX', 'groceries')).toEqual({ kind: 'conflict', existing: inFlight });
  });
});
