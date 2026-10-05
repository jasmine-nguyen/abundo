// WHIT-715 QA — the row's pace words and the detail warning never disagree, across budgets with
// pending, rollover buffers either side of zero, and every point in the cycle.
import { describe, it, expect } from '@jest/globals';
import { budgetViews, budgetDetail } from '../context';
import { makeState, cat, budget } from './factory';

describe('row and detail pace words agree (WHIT-715 QA)', () => {
  // [A1] (P0) "over plan" on the row ⇔ "Over plan — ease up" in detail; "under plan" ⇒ green detail.
  it('[A1] behind/ahead on the row matches the detail status for every case in the grid', () => {
    let behindSeen = 0;
    let aheadSeen = 0;
    for (const daysLeft of [1, 7, 13])
      for (const posted of [0, 20, 47, 49.6, 50.4, 52, 70, 99, 130])
        for (const pending of [0, 15])
          for (const carryover of [0, 40, -30]) {
            const state = makeState({
              categories: [cat()],
              budgets: [budget({ id: 'coffee', budget: 100, posted, pending, rollover: carryover !== 0, carryover })],
              cycleLen: 14, daysLeft,
            });
            const row = budgetViews(state).rows[0];
            const detail = budgetDetail(state, 'coffee')!;
            const where = JSON.stringify({ daysLeft, posted, pending, carryover, row: row.paceLabel, detail: detail.statusLabel });
            const rowBehind = row.paceLabel.endsWith(' over plan');
            expect([where, rowBehind]).toEqual([where, detail.statusLabel === 'Over plan — ease up']);
            if (rowBehind) behindSeen++;
            if (row.paceLabel.endsWith(' under plan')) {
              aheadSeen++;
              expect([where, detail.statusLabel]).toEqual([where, 'On track for payday']);
            }
          }
    expect(behindSeen).toBeGreaterThan(0);
    expect(aheadSeen).toBeGreaterThan(0);
  });
});
