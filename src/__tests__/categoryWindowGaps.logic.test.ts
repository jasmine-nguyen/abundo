// WHIT-308 — cycleWindow GAPS (adversarial): edges categoryWindow.logic.test.ts leaves open.
//   [A-W2] a monthly (length 30) FULL prior window's exact boundaries (abutting, 30 days)
//   [A-W3] the 3rd prior cycle (n>=2, beyond the covered 2nd) stays abutting
// Runs under TZ=Australia/Melbourne (see the test script), same as the sibling suite.
import { describe, it, expect } from '@jest/globals';
import { cycleWindow } from '../context';

const day = (y: number, m: number, d: number) => new Date(y, m - 1, d);
const cycle = (length: number, last_pay_date: string) => ({ length, last_pay_date });

describe('cycleWindow — adversarial gaps', () => {
  // [A-W2] The sibling suite only checks length 30 for the CURRENT window. Here the 1st prior
  // FULL monthly window must be exactly 30 days [start-30 … start-1], abutting the current start
  // with no overlap or gap. Fail-on-revert: an off-by-one in priorEnd (`(cycle-1)*length` vs
  // `(cycle-1)*length + 1`) would overlap or gap the current start.
  it('a full monthly (30-day) 1st prior window abuts the current start, exactly 30 days', () => {
    // current: [2026-06-01, 2026-06-15]; 1st prior ends the day before the current start.
    expect(cycleWindow(cycle(30, '2026-06-01'), 1, day(2026, 6, 15)))
      .toEqual({ start: '2026-05-02', end: '2026-05-31' }); // May 2..May 31 inclusive = 30 days
  });

  // [A-W3] Beyond the covered 2nd prior — the 3rd fortnightly prior still steps back a clean
  // length and abuts the 2nd. current start 2026-06-06 → 3rd prior [2026-04-25, 2026-05-08].
  it('the 3rd prior cycle steps back another full length, still abutting', () => {
    expect(cycleWindow(cycle(14, '2026-06-06'), 3, day(2026, 6, 15)))
      .toEqual({ start: '2026-04-25', end: '2026-05-08' });
  });
});
