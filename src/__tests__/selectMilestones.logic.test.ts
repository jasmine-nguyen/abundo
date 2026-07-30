// WHIT-367 — selectMilestones: a passthrough that FAILS LOUDLY on a malformed /milestones
// payload, mirroring selectGoals. A non-array must throw so the query rejects and the screen
// keeps its built-in default plan, rather than a cryptic "milestones.map is not a function".
import { describe, it, expect } from '@jest/globals';
import { selectMilestones, milestonesKey } from '../queries';

// The WHIT-377 editor's save will patch the ['milestones'] cache with a LITERAL key (like the
// goal writes), so the literal and the exported key can silently drift. Lock them together now.
describe('milestonesKey', () => {
  it('deep-equals the literal ["milestones"] a future writer will use', () => {
    expect(milestonesKey).toEqual(['milestones']);
  });
});

describe('selectMilestones', () => {
  it('passes a real milestones array through unchanged (same reference identity)', () => {
    const raw = [{ id: 'a', label: 'Start', targetBalance: 300000, targetDate: '2026-01-01' }];
    expect(selectMilestones(raw)).toBe(raw as unknown);
  });

  it('accepts a genuinely empty (unset) plan ([])', () => {
    expect(selectMilestones([])).toEqual([]);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a wrapped object', { milestones: [] }],
    ['a string', 'oops'],
  ])('throws on %s (not an array)', (_label, bad) => {
    expect(() => selectMilestones(bad)).toThrow(/expected an array from \/milestones/);
  });
});
