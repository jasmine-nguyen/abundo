// WHIT-556 4b — GAP tests for budgetSpreadEligibility the implementer's units don't cover.
// Already covered by budgetSpread.logic.test.ts: hidden(no cat/no budget/Income/Savings),
// start(whole-cent over, with overspend), edit(active plan), rollover-hidden, sub-cent-hidden,
// at-budget-hidden, server-available honoured, and budgetDetail.{canStartSpread,overspend} parity.
// These add: pending spend counts toward the overspend, and the spread>rollover check ordering.
import { describe, it, expect } from '@jest/globals';
import { budgetSpreadEligibility } from '../context';
import type { Budget } from '../context';
import { cat, budget } from './factory';

const spend = cat({ id: 'sink', name: 'Sink', bucket: 'Lifestyle' });
const bud = (over: Partial<Budget> = {}): Budget => budget({ id: 'sink', budget: 100, posted: 0, pending: 0, ...over });

describe('budgetSpreadEligibility — gap coverage', () => {
  // [G1] spent = posted + pending: a PENDING charge that tips the envelope over must count,
  // otherwise a still-pending bill would never offer the prompt. posted 90 + pending 20 = 110 > 100.
  it('[G1] pending spend counts toward the overspend (posted + pending), not posted alone', () => {
    const r = budgetSpreadEligibility(spend, bud({ posted: 90, pending: 20 }));
    expect(r.entry).toBe('start');
    expect(r.overspend).toBe(10);
    // pending alone can tip it over too
    expect(budgetSpreadEligibility(spend, bud({ posted: 0, pending: 130 })).entry).toBe('start');
  });

  // [G1b] under the envelope once pending is added stays hidden (guards an over-eager gate).
  it('[G1b] under the envelope with pending included → hidden', () => {
    expect(budgetSpreadEligibility(spend, bud({ posted: 50, pending: 20 })).entry).toBe('hidden');
  });

  // [G2] the spread check precedes the rollover check: an active plan wins even if rollover is set
  // (the XOR invariant should never both-set them, but the ordering must not silently hide an
  // editable plan). Guards budgetDetail's edit/remove entry from vanishing.
  it('[G2] an active plan returns "edit" before the rollover guard can hide it', () => {
    const b = bud({ posted: 200, rollover: true, carryover: 0, spread: { amount: 200, cycles: 4, index: 1, adjustment: -50 } });
    expect(budgetSpreadEligibility(spend, b).entry).toBe('edit');
  });
});
