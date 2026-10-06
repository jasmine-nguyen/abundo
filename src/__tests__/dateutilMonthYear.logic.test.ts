// WHIT-762 — one shared "Mon YYYY" label (goal progress, milestone, goal-date label)
// instead of three hand-rolled copies. Hand-parsed from the ISO string, so it never
// shifts a month under the Melbourne runner timezone.
import { describe, it, expect } from '@jest/globals';
import { formatMonthYear } from '../dateutil';

describe('formatMonthYear', () => {
  it('labels an ISO date as "Mon YYYY"', () => {
    expect(formatMonthYear('2026-08-15')).toBe('Aug 2026');
  });

  it('keeps the month and year at the year edges (no timezone shift)', () => {
    expect(formatMonthYear('2026-01-01')).toBe('Jan 2026');
    expect(formatMonthYear('2026-12-31')).toBe('Dec 2026');
  });

  it('passes an unparseable date through unchanged', () => {
    expect(formatMonthYear('not-a-date')).toBe('not-a-date');
    expect(formatMonthYear('2030-13-01')).toBe('2030-13-01');
  });
});
