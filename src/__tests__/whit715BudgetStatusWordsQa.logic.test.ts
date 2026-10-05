// WHIT-715 QA — the row's behind-pace flag and the detail warning never disagree, across budgets with
// pending, rollover buffers either side of zero, and every point in the cycle.
import { describe, it, expect } from '@jest/globals';
import { budgetViews, budgetDetail } from '../context';
import { makeState, cat, budget } from './factory';

describe('row and detail pace words agree (WHIT-715 QA)', () => {
  // [A1] (P0) behind pace on the row ⇔ "Over plan — ease up" in detail.
  it('[A1] behind on the row matches the detail status for every case in the grid', () => {
    let behindSeen = 0;
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
            const where = JSON.stringify({ daysLeft, posted, pending, carryover, row: row.behindPace, detail: detail.statusLabel });
            const rowBehind = row.behindPace;
            expect([where, rowBehind]).toEqual([where, detail.statusLabel === 'Over plan — ease up']);
            if (rowBehind) behindSeen++;
          }
    expect(behindSeen).toBeGreaterThan(0);
  });
});
