// WHIT-822 QA — the maths under the milestones card: requiredRepayment's new target balance
// (the pace line's engine) and how far the next segment fills.
import { it, expect } from '@jest/globals';
import { requiredRepayment, milestoneView } from '../context';
import { LOAN_FACTS } from './factory';
import { SAVED_MILESTONES } from './support/milestonePlan';

// Month-by-month: interest on, repayment off. A wrong formula lands off the target.
function balanceAfter(balance: number, i: number, pmt: number, months: number) {
  let owing = balance;
  for (let m = 0; m < months; m++) owing = owing * (1 + i) - pmt;
  return owing;
}

// [A1]
it.each<[string, number, number, number, number]>([
  ['home loan down to a milestone', 275000, 0.0574 / 12, 3, 200000],
  ['long horizon, high target', 600000, 0.06 / 12, 60, 450000],
  ['target 0 clears the loan', 100000, 0.01, 42, 0],
  ['0% rate, straight-line to the target', 12000, 0, 12, 6000],
])('requiredRepayment lands exactly on the target: %s', (_case, balance, i, months, target) => {
  const pmt = requiredRepayment(balance, i, months, target);
  expect(pmt).not.toBeNull();
  expect(balanceAfter(balance, i, pmt!, months)).toBeCloseTo(target, 4);
});

// [A2]
it('requiredRepayment has nothing to pay when the balance is already at or under the target', () => {
  expect(requiredRepayment(200000, 0.005, 3, 200000)).toBeNull();
  expect(requiredRepayment(190000, 0.005, 3, 200000)).toBeNull();
});

// [A3] Saved plan: Start $300k → Midway $200k → Payoff $100k.
it.each<[string, number | null, number]>([
  ['halfway from Start to Midway', 250000, 50],
  ['just under Start', 299000, 1],
  ['exactly at Midway: Payoff is next, nothing into it yet', 200000, 0],
  ['three quarters into Payoff', 125000, 75],
  ['the first milestone is still next', 350000, 0],
  ['every milestone reached', 90000, 0],
  ['balance not loaded', null, 0],
])('next segment fill: %s', (_case, balance, pct) => {
  const m = milestoneView({ loanFacts: LOAN_FACTS, homeLoan: { balance, asOf: null }, milestones: SAVED_MILESTONES });
  expect(m.nextSegmentPct).toBeCloseTo(pct, 6);
});
