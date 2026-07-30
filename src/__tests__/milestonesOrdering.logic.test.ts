// WHIT-377 — milestonesOrderingError + milestoneOutOfOrderRows: the pure client guard that mirrors
// the server's set_milestones contract (lambda_api/handler.py:2073-2142), so the editor blocks a
// bad plan before any round-trip. This is the fail-on-revert anchor for the ordering rule.
import { describe, it, expect } from '@jest/globals';
import { milestonesOrderingError, milestoneOutOfOrderRows, MILESTONE_LABEL_MAX_LEN, MILESTONE_MAX_COUNT } from '../milestones';

type Row = { label: string; targetBalance: number; targetDate: string };

// A valid, strictly paid-down plan (decreasing balance, increasing date).
const VALID: Row[] = [
  { label: 'Start',  targetBalance: 300000, targetDate: '2026-01-01' },
  { label: 'Midway', targetBalance: 200000, targetDate: '2027-01-01' },
  { label: 'Payoff', targetBalance: 100000, targetDate: '2028-01-01' },
];

describe('milestonesOrderingError — accepts valid plans', () => {
  it('returns null for a strictly paid-down multi-row plan', () => {
    expect(milestonesOrderingError(VALID)).toBeNull();
  });

  it('returns null for a single-row plan (no pair to compare)', () => {
    expect(milestonesOrderingError([{ label: 'Only', targetBalance: 300000, targetDate: '2026-01-01' }])).toBeNull();
  });

  it('allows a final target balance of exactly 0 (loan fully paid)', () => {
    expect(milestonesOrderingError([
      { label: 'Start', targetBalance: 100000, targetDate: '2026-01-01' },
      { label: 'Done',  targetBalance: 0,      targetDate: '2027-01-01' },
    ])).toBeNull();
  });
});

describe('milestonesOrderingError — list-level limits', () => {
  it('rejects an empty list', () => {
    expect(milestonesOrderingError([])).toMatch(/at least one/i);
  });

  it('rejects more than the max number of rows', () => {
    const many: Row[] = Array.from({ length: MILESTONE_MAX_COUNT + 1 }, (_, i) => ({
      label: `Step ${i}`, targetBalance: 1_000_000 - i, targetDate: isoForIndex(i),
    }));
    expect(milestonesOrderingError(many)).toMatch(new RegExp(`at most ${MILESTONE_MAX_COUNT}`));
  });
});

describe('milestonesOrderingError — per-row field checks', () => {
  it('rejects a blank label', () => {
    expect(milestonesOrderingError([{ label: '   ', targetBalance: 100000, targetDate: '2026-01-01' }])).toMatch(/name/i);
  });

  it('rejects a label longer than the max length', () => {
    expect(milestonesOrderingError([{ label: 'x'.repeat(MILESTONE_LABEL_MAX_LEN + 1), targetBalance: 100000, targetDate: '2026-01-01' }])).toMatch(/at most/i);
  });

  it.each([
    ['NaN (blank/partial input)', NaN],
    ['negative', -1],
    ['above the max', 1_000_000_001],
  ])('rejects a target balance that is %s', (_label, bad) => {
    expect(milestonesOrderingError([{ label: 'Step', targetBalance: bad, targetDate: '2026-01-01' }])).toMatch(/target balance/i);
  });

  it.each([
    ['unset', ''],
    ['not a date', 'someday'],
    ['impossible calendar date', '2026-02-30'],
    ['out-of-range month', '2026-13-01'],
  ])('rejects a target date that is %s', (_label, bad) => {
    expect(milestonesOrderingError([{ label: 'Step', targetBalance: 100000, targetDate: bad }])).toMatch(/target date/i);
  });
});

describe('milestonesOrderingError — the ordering rule', () => {
  it.each([
    ['a rising balance', [VALID[0], { label: 'Up', targetBalance: 400000, targetDate: '2027-01-01' }]],
    ['an equal balance', [VALID[0], { label: 'Same', targetBalance: 300000, targetDate: '2027-01-01' }]],
    ['an earlier date', [VALID[0], { label: 'Back', targetBalance: 200000, targetDate: '2025-01-01' }]],
    ['an equal date',   [VALID[0], { label: 'SameDay', targetBalance: 200000, targetDate: '2026-01-01' }]],
  ])('rejects %s between neighbours', (_label, rows) => {
    expect(milestonesOrderingError(rows as Row[])).toMatch(/lower balance and a later date/i);
  });
});

describe('milestoneOutOfOrderRows — per-row flags for the live warning', () => {
  it('flags no rows for a valid plan', () => {
    expect(milestoneOutOfOrderRows(VALID)).toEqual([false, false, false]);
  });

  it('never flags the first row (nothing above it)', () => {
    const rising = [{ label: 'A', targetBalance: 100000, targetDate: '2026-01-01' }, { label: 'B', targetBalance: 200000, targetDate: '2027-01-01' }];
    expect(milestoneOutOfOrderRows(rising)[0]).toBe(false);
  });

  it('flags exactly the row that breaks the order', () => {
    // Row 1 (index 1) rises in balance → flagged; rows 0 and 2 are fine relative to their predecessor.
    const rows = [
      { label: 'A', targetBalance: 300000, targetDate: '2026-01-01' },
      { label: 'B', targetBalance: 400000, targetDate: '2027-01-01' }, // rises → out of order
      { label: 'C', targetBalance: 100000, targetDate: '2028-01-01' },
    ];
    expect(milestoneOutOfOrderRows(rows)).toEqual([false, true, false]);
  });
});

// Distinct, increasing ISO dates for the >50 fixture.
function isoForIndex(i: number): string {
  const year = 2026 + i;
  return `${year}-01-01`;
}
