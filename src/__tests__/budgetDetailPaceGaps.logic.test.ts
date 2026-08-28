// Adversarial GAP tests for budgetDetail's spend pace status. Complements the
// 'budgetDetail — spend pace status' block in budget.logic.test.ts: covers the exact
// ==0.5 pace boundary, negative carryover (borrowed envelope), end-of-cycle (elapsed=1),
// the statusLabel↔statusColor pairing invariant, spent==available at 100%, and confirms
// the Income branch is untouched by the pace change.
import { describe, it, expect } from '@jest/globals';
import { budgetDetail } from '../context';
import type { Budget } from '../context';
import { C } from '../theme';
import { makeState, cat, budget } from './factory';

const detail = (over: Partial<Budget>, clock: { cycleLen: number; daysLeft: number }, c = cat()) =>
  budgetDetail(makeState({ categories: [c], budgets: [budget({ id: 'coffee', pending: 0, ...over })], ...clock }), 'coffee')!;

describe('budgetDetail pace — gaps', () => {
  // [G1] EXACT boundary: spent - target == 0.5 is NOT > 0.5 → stays green.
  // Fail-on-revert if the branch is loosened to `>= 0.5`.
  it('[G1] spent-target exactly 0.50 over stays green (strict >, not >=)', () => {
    // elapsed 7/14 = 0.5, target = 100*0.5 = 50; spent 50.5 → diff exactly 0.50.
    const d = detail({ budget: 100, posted: 50.5 }, { cycleLen: 14, daysLeft: 7 });
    expect(d.statusLabel).toBe('On target — keep it up');
    expect(d.statusColor).toBe(C.good);
  });

  // [G2] Just past the boundary flips amber — locks the tolerance tightly with [G1].
  it('[G2] spent-target 0.51 over flips to amber', () => {
    const d = detail({ budget: 100, posted: 50.51 }, { cycleLen: 14, daysLeft: 7 });
    expect(d.statusLabel).toBe('Ahead of pace — ease up');
    expect(d.statusColor).toBe(C.warn);
  });

  // [G3] Negative carryover (borrowed envelope): pace still rides the BASE budget, so spent
  // under the shrunken available but past base pace reads amber, not green.
  it('[G3] borrowed envelope: under reduced available but past base pace → amber', () => {
    // available = 100 + (-20) = 80; elapsed 0.5 → base target 50; spent 70 < 80 (not over) but 70-50=20 → amber.
    const d = detail({ budget: 100, posted: 70, rollover: true, carryover: -20 }, { cycleLen: 14, daysLeft: 7 });
    expect(d.statusColor).not.toBe(C.good);
    expect(d.statusLabel).toBe('Ahead of pace — ease up');
    expect(d.statusColor).toBe(C.warn);
  });

  // [G4] Negative carryover, spent past the shrunken available → over (red) wins over amber.
  it('[G4] borrowed envelope: spent over reduced available → red, over dominates pace', () => {
    // available = 100 + (-40) = 60; spent 65 > 60 → over budget red.
    const d = detail({ budget: 100, posted: 65, rollover: true, carryover: -40 }, { cycleLen: 14, daysLeft: 7 });
    expect(d.statusLabel).toBe('Over budget — ease up');
    expect(d.statusColor).toBe(C.bad);
  });

  // [G5] End of cycle (daysLeft 0 → elapsed 1 → target == budget): spending exactly the base
  // budget is on pace → green. This is the CORRECT-100% case, opposite of the day-1 mortgage bug.
  it('[G5] elapsed=1: spent == budget == available at 100% stays green', () => {
    const d = detail({ budget: 100, posted: 100 }, { cycleLen: 14, daysLeft: 0 });
    expect(d.statusLabel).toBe('On target — keep it up');
    expect(d.statusColor).toBe(C.good);
    expect(d.spentBig).toBe('$100'); // sanity: 100% spent
  });

  // [G6] End of cycle with a rollover buffer: past base budget (target) but under available → amber.
  it('[G6] elapsed=1: spent over base budget but under buffered available → amber', () => {
    // target = base 100 * 1 = 100; available = 100 + 50 = 150; spent 110 → not over, 110-100=10 → amber.
    const d = detail({ budget: 100, posted: 110, rollover: true, carryover: 50 }, { cycleLen: 14, daysLeft: 0 });
    expect(d.statusLabel).toBe('Ahead of pace — ease up');
    expect(d.statusColor).toBe(C.warn);
  });

  // [G7] Pairing invariant: the label and colour are NEVER mismatched across a spread of
  // scenarios (e.g. an amber label with a green colour). Guards the two `let`s staying in lock-step.
  it('[G7] statusLabel and statusColor are always the matching pair', () => {
    const scenarios: Array<[Partial<Budget>, { cycleLen: number; daysLeft: number }]> = [
      [{ budget: 100, posted: 0 }, { cycleLen: 14, daysLeft: 7 }],       // green
      [{ budget: 100, posted: 60 }, { cycleLen: 14, daysLeft: 12 }],     // amber
      [{ budget: 100, posted: 130 }, { cycleLen: 14, daysLeft: 7 }],     // red
      [{ budget: 3667, posted: 3667 }, { cycleLen: 30, daysLeft: 29 }],  // amber (mortgage)
      [{ budget: 100, posted: 90 }, { cycleLen: 14, daysLeft: 1 }],      // green (late, under pace)
      [{ budget: 100, posted: 100 }, { cycleLen: 14, daysLeft: 0 }],     // green (end, 100%)
    ];
    const pair: Record<string, string> = {
      'On target — keep it up': C.good,
      'Ahead of pace — ease up': C.warn,
      'Over budget — ease up': C.bad,
    };
    for (const [b, clock] of scenarios) {
      const d = detail(b, clock);
      expect(Object.keys(pair)).toContain(d.statusLabel);
      expect(d.statusColor).toBe(pair[d.statusLabel]);
    }
  });

  // [G8] Regression guard: the Income branch is untouched by the pace change. An income
  // (earn-target) budget far past linear pace must still read the calm earn copy/colour,
  // never the amber spend caution. (Not expected to fail on reverting `aheadOfPace`.)
  it('[G8] income budget past pace stays "keep earning", never amber', () => {
    const income = cat({ id: 'coffee', bucket: 'Income', name: 'Salary' });
    // actual 900 < target 1000 (not met) but way past linear pace (500). Income → calm.
    const d = detail({ budget: 1000, posted: 900 }, { cycleLen: 14, daysLeft: 7 }, income);
    expect(d.statusLabel).toBe('On track — keep earning');
    expect(d.statusColor).toBe(C.textInfo);
    expect(d.statusLabel).not.toBe('Ahead of pace — ease up');
    expect(d.statusColor).not.toBe(C.warn);
  });
});
