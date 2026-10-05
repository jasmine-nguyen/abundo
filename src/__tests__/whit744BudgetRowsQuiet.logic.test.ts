// WHIT-744 — a budget row no longer carries a pending line or an over/under plan line; it still
// marks a row that is spending too fast (behindPace), which orders urgent rows first.
import { describe, it, expect } from '@jest/globals';
import { budgetRowFor } from './support/budgetsTab';

describe('budget rows drop the pending and plan lines (WHIT-744)', () => {
  it('a fast-spending row with pending has no pending or plan label, but is still behind pace', () => {
    // Halfway through the cycle: $80 spent ($10 pending) of $100 → pace target $50, spending too fast.
    const fast = budgetRowFor({ budget: 100, posted: 70, pending: 10 });
    expect('pendingLabel' in fast).toBe(false);
    expect('paceLabel' in fast).toBe(false);
    expect(fast.behindPace).toBe(true);

    const calm = budgetRowFor({ budget: 100, posted: 20, pending: 0 });
    expect(calm.behindPace).toBe(false);
  });
});
