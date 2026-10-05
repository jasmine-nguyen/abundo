// WHIT-742 — a rollover budget's detail page lists the cycles its carryover came from, newest
// first, plus one remainder line for anything older, so the lines add up to the carryover note.
import { describe, it, expect } from '@jest/globals';
import { budgetDetailFor } from './support/budgetsTab';

const cycle = (start: string, end: string, leftover: number, extra: object = {}) => ({
  start, end, target: 200, spent: 200 - leftover, leftover, settling: false, ...extra,
});

describe('budget detail lists the cycles behind a carryover (WHIT-742)', () => {
  it('Utilities: each past overspend cycle on its own line, settling ones marked', () => {
    const utilities = {
      budget: 200, posted: 100, rollover: true, carryover: -859, carryoverEarlier: 0,
      carryoverCycles: [
        cycle('2026-09-12', '2026-09-25', -519.6, { settling: true }),
        cycle('2026-08-29', '2026-09-11', -339.4),
      ],
    };
    const detail = budgetDetailFor(utilities);

    expect(detail.carryoverLine).toBe('Includes $859 past overspend');
    expect(detail.carryoverCycleLines).toHaveLength(2);
    expect(detail.carryoverCycleLines).toMatchObject([
      { label: '12 Sep – 25 Sep', amount: '−$520', settling: true },
      { label: '29 Aug – 11 Sep', amount: '−$339', settling: false },
    ]);
  });

  it('leftover cycles read as positive and an older legacy amount gets a "Before" line', () => {
    const leftovers = {
      budget: 200, posted: 50, rollover: true, carryover: 176, carryoverEarlier: 40,
      carryoverCycles: [cycle('2026-09-12', '2026-09-25', 136)],
    };
    expect(budgetDetailFor(leftovers).carryoverCycleLines).toMatchObject([
      { label: '12 Sep – 25 Sep', amount: '+$136', settling: false },
      { label: 'Before 12 Sep', amount: '+$40' },
    ]);
  });

  it('rebuilt cycles are flagged and the gap reads "Not matched to a cycle"', () => {
    const rebuilt = {
      budget: 200, posted: 50, rollover: true, carryover: -300, carryoverEarlier: -20,
      carryoverCycles: [cycle('2026-09-12', '2026-09-25', -280, { rebuilt: true })],
    };
    expect(budgetDetailFor(rebuilt).carryoverCycleLines).toMatchObject([
      { label: '12 Sep – 25 Sep', amount: '−$280', rebuilt: true },
      { label: 'Not matched to a cycle', amount: '−$20' },
    ]);
  });

  it('no saved cycles yet: the whole carryover is one "Earlier cycles" line', () => {
    const legacy = { budget: 200, posted: 50, rollover: true, carryover: -859, carryoverEarlier: -859, carryoverCycles: [] };
    expect(budgetDetailFor(legacy).carryoverCycleLines).toMatchObject([
      { label: 'Earlier cycles', amount: '−$859' },
    ]);
  });

  it('a budget without rollover lists no cycles', () => {
    expect(budgetDetailFor({ budget: 100, posted: 40 }).carryoverCycleLines).toEqual([]);
  });
});
