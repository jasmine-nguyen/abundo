// WHIT-393 — [C1]-[C3] the client milestone balance cap is the number the client actually enforces.
// The new pytest twin guard (tests/lambda_api/test_milestone_cap_sync.py) compares the TEXT of
// `export const MILESTONE_BALANCE_MAX` in src/milestones.ts against the server's
// _MILESTONE_BALANCE_MAX. That proves the two DECLARATIONS agree — it cannot see whether the
// client validator still uses the declared value. Nothing else does either: the existing
// milestonesOrdering.logic.test.ts probes the cap with a hand-typed 1_000_000_001 and never
// imports the constant, so inlining a different literal at src/milestones.ts:91 (or turning the
// `>` into `>=`) would leave the whole suite — and the twin guard — green while the editor
// rejected balances the server accepts.
// The loan-facts twin has this cover already ([D7] server side, [G4]-[G6] client side); this is
// the missing half for milestones.
import { describe, it, expect } from '@jest/globals';
import { milestonesOrderingError, MILESTONE_BALANCE_MAX } from '../milestones';

// One row: no neighbour, so only the per-row field checks can fire and the balance is the
// only thing under test.
const oneRow = (targetBalance: number) => [{ label: 'Step', targetBalance, targetDate: '2026-01-01' }];

describe('MILESTONE_BALANCE_MAX is the enforced client ceiling', () => {
  it('[C1] a target balance EXACTLY at the cap is accepted', () => {
    // The strict-`>` boundary. A `>=` regression, or an inlined lower literal, reddens here.
    expect(milestonesOrderingError(oneRow(MILESTONE_BALANCE_MAX))).toBeNull();
  });

  it('[C2] one dollar over the cap is rejected', () => {
    // Derived from the constant (not the hand-typed 1_000_000_001 elsewhere), so raising the
    // inlined literal above the declared cap reddens here rather than passing by luck.
    expect(milestonesOrderingError(oneRow(MILESTONE_BALANCE_MAX + 1))).toMatch(/target balance/i);
  });

  it('[C3] the cap is a positive safe integer, so the +1 probe is a real step', () => {
    // Past 2^53 `MAX + 1 === MAX`, which would make [C2] assert nothing. Pin the precondition
    // (same reasoning as the loan-facts suites' String() note) instead of leaving it to luck.
    expect(Number.isSafeInteger(MILESTONE_BALANCE_MAX)).toBe(true);
    expect(MILESTONE_BALANCE_MAX).toBeGreaterThan(0);
  });
});
