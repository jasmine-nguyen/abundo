// WHIT-715 QA — the detail screen's pace words across budgets with pending, rollover buffers either
// side of zero, and every point in the cycle: never "over plan" when over budget, always in muted ink.
import { describe, it, expect } from '@jest/globals';
import { C } from '../theme';
import { budgetDetailFor } from './support/budgetsTab';

describe('detail pace words across the grid (WHIT-715 QA)', () => {
  // [A1] (P0) "Over plan — ease up" only when under budget, and always in C.textInfo.
  it('[A1] the detail pace words hold for every case in the grid', () => {
    let behindSeen = 0;
    for (const daysLeft of [1, 7, 13])
      for (const posted of [0, 20, 47, 49.6, 50.4, 52, 70, 99, 130])
        for (const pending of [0, 15])
          for (const carryover of [0, 40, -30]) {
            const detail = budgetDetailFor(
              { budget: 100, posted, pending, rollover: carryover !== 0, carryover },
              { cycleLen: 14, daysLeft },
            );
            const where = JSON.stringify({ daysLeft, posted, pending, carryover, detail: detail.statusLabel });
            const over = posted + pending > 100 + carryover;
            const behind = detail.statusLabel === 'Over plan — ease up';
            if (over) expect([where, behind]).toEqual([where, false]);
            if (!behind) continue;
            expect([where, detail.statusColor]).toEqual([where, C.textInfo]);
            behindSeen++;
          }
    expect(behindSeen).toBeGreaterThan(0);
  });
});
