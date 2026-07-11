// WHIT-233 — selectGoals: a passthrough that FAILS LOUDLY on a malformed /goals payload,
// mirroring selectCategories/selectRules. A non-array must throw so the query rejects and the
// hub shows its error card, rather than a cryptic "goals.map is not a function" downstream.
import { describe, it, expect } from '@jest/globals';
import { selectGoals, goalsKey } from '../queries';

// context.tsx's goal writes patch the ['goals'] cache with a LITERAL key (it can't import
// goalsKey without a circular import — see the queries.ts comment), so the literal and the
// exported key can silently drift. Lock them together here (WHIT-233 code-review R5).
describe('goalsKey', () => {
  it('deep-equals the literal ["goals"] the context writers use', () => {
    expect(goalsKey).toEqual(['goals']);
  });
});

describe('selectGoals', () => {
  it('passes a real goals array through unchanged (same reference identity)', () => {
    const raw = [{ id: 'g1', name: 'Emergency fund', icon: 'umbrella', direction: 'grow',
      target_amount: 10000, target_date: '2026-12-01', account_id: 'up-spending' }];
    expect(selectGoals(raw)).toBe(raw as unknown);
  });

  it('accepts a genuinely empty backlog ([])', () => {
    expect(selectGoals([])).toEqual([]);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a wrapped object', { goals: [] }],
    ['a string', 'oops'],
  ])('throws on %s (not an array)', (_label, bad) => {
    expect(() => selectGoals(bad)).toThrow(/expected an array from \/goals/);
  });
});
