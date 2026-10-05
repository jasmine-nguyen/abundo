// WHIT-742 QA — edges of the cycle lines under a rollover carryover on the budget detail page.
import { describe, it, expect } from '@jest/globals';
import { budgetDetailFor, budgetRowsFor, rowText } from './support/budgetsTab';
import { toBudget } from '../model';
import { budget, cat } from './factory';

const cycle = (start: string, end: string, leftover: number, extra: object = {}) => ({
  start, end, target: 200, spent: 200 - leftover, leftover, settling: false, ...extra,
});

describe('WHIT-742 QA: carryover cycle lines', () => {
  // [C1] (P0) The wire fields reach the model.
  it('toBudget maps carryover_cycles and carryover_earlier from the server row', () => {
    const cycles = [{ ...cycle('2026-09-12', '2026-09-25', -520), settling: true }];
    const b = toBudget('x', { target: 200, posted: 0, pending: 0, rollover: true, carryover: -879, carryover_cycles: cycles, carryover_earlier: -359 });
    expect(b.carryoverCycles).toEqual(cycles);
    expect(b.carryoverEarlier).toBe(-359);
  });

  // [C2] (P0) The remainder line shows from 50c up, and not below.
  it('a remainder under 50c gets no line; exactly 50c does', () => {
    const base = { budget: 200, posted: 0, rollover: true, carryover: -520.4, carryoverCycles: [cycle('2026-09-12', '2026-09-25', -520)] };
    expect(budgetDetailFor({ ...base, carryoverEarlier: -0.4 }).carryoverCycleLines).toHaveLength(1);
    expect(budgetDetailFor({ ...base, carryover: -520.5, carryoverEarlier: -0.5 }).carryoverCycleLines).toMatchObject([
      { label: '12 Sep – 25 Sep' }, { label: 'Before 12 Sep', amount: '−$1' },
    ]);
  });

  // [C3] (P1) No note → no lines, even when cycles cancel each other out.
  it('a carryover that nets to under 50c shows neither the note nor any cycle lines', () => {
    const detail = budgetDetailFor({
      budget: 200, posted: 0, rollover: true, carryover: 0.2, carryoverEarlier: 0.2,
      carryoverCycles: [cycle('2026-09-12', '2026-09-25', 100), cycle('2026-08-29', '2026-09-11', -100)],
    });
    expect(detail.carryoverLine).toBe('');
    expect(detail.carryoverCycleLines).toEqual([]);
  });

  // [C4] (P1) "Before" names the OLDEST listed cycle, even with a settling one in front; keys unique.
  it('the remainder line is dated from the oldest cycle and every line has its own key', () => {
    const detail = budgetDetailFor({
      budget: 200, posted: 0, rollover: true, carryover: -100, carryoverEarlier: -60,
      carryoverCycles: [
        cycle('2026-09-26', '2026-10-09', 20, { settling: true }),
        cycle('2026-09-12', '2026-09-25', -40),
        cycle('2026-08-29', '2026-09-11', -20),
      ],
    });
    const lines = detail.carryoverCycleLines;
    expect(lines.map((l) => l.label)).toEqual(['26 Sep – 9 Oct', '12 Sep – 25 Sep', '29 Aug – 11 Sep', 'Before 29 Aug']);
    expect(lines.map((l) => l.amount)).toEqual(['+$20', '−$40', '−$20', '−$60']);
    expect(new Set(lines.map((l) => l.key)).size).toBe(lines.length);
  });

  // [C5] (P1) A legacy budget with no cycle fields at all (old cached data) still lists one line.
  it('a rollover budget missing both new fields falls back to no cycles and no remainder', () => {
    const detail = budgetDetailFor({ budget: 200, posted: 0, rollover: true, carryover: -859, carryoverCycles: undefined, carryoverEarlier: undefined });
    expect(detail.carryoverLine).toBe('Includes $859 past overspend');
    expect(detail.carryoverCycleLines).toEqual([]);
  });

  // [C6] (P0) Nothing changes on the Budgets tab row.
  it('the Budgets tab row text carries none of the cycle lines', () => {
    const c = cat();
    const b = budget({
      id: c.id, budget: 200, posted: 0, pending: 0, rollover: true, carryover: -859, carryoverEarlier: -339,
      carryoverCycles: [cycle('2026-09-12', '2026-09-25', -520)],
    });
    const text = budgetRowsFor([c], [b]).map(rowText).join(' ');
    expect(text).toContain('Includes $859 past overspend');
    expect(text).not.toMatch(/12 Sep|−\$520|Before|Earlier cycles/);
  });
});
