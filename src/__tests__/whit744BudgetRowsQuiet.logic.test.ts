// WHIT-744 — a budget row no longer carries a pending line or an over/under plan line, and
// (WHIT-750) no "spending too fast" flag either; the pace warning lives on the detail screen only.
import { describe, it, expect } from '@jest/globals';
import { budgetRowFor } from './support/budgetsTab';

describe('budget rows drop the pending and plan lines (WHIT-744)', () => {
  it('a fast-spending row with pending has no pending label, plan label or pace flag', () => {
    // Halfway through the cycle: $80 spent ($10 pending) of $100 → pace target $50, spending too fast.
    const fast = budgetRowFor({ budget: 100, posted: 70, pending: 10 });
    expect('pendingLabel' in fast).toBe(false);
    expect('paceLabel' in fast).toBe(false);
    expect('behindPace' in fast).toBe(false);
  });
});
