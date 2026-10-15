import { it, expect } from '@jest/globals';
import { homeLoanProgressLine, isHomeLoanAccount } from '../homeLoanAccount';
import { EMPTY_LOAN_FACTS } from '../model';
import type { AccountBalance } from '../api';
import { SAVED_MILESTONES } from './support/milestonePlan';

const FACTS = { ...EMPTY_LOAN_FACTS, original: 400000, homeValue: 600000, lvr: 0.8, ratePct: 6, baseRepay: 1500, extra: 0 };

it.each([
  ['mortgage', true],
  ['checking', false],
  [null, false],
])('isHomeLoanAccount(account_type %s) → %s', (accountType, expected) => {
  expect(isHomeLoanAccount({ account_type: accountType } as AccountBalance)).toBe(expected);
});

it('isHomeLoanAccount is false with no balance', () => {
  expect(isHomeLoanAccount(undefined)).toBe(false);
});

it.each([
  ['the next milestone', 250000, SAVED_MILESTONES, EMPTY_LOAN_FACTS, 'Next milestone: $50,000 to go'],
  ['every milestone reached', 90000, SAVED_MILESTONES, EMPTY_LOAN_FACTS, 'Target reached'],
  ['% paid off when no plan is saved', 300000, [], FACTS, '25% paid off'],
  ['nothing when nothing is set up', 300000, [], EMPTY_LOAN_FACTS, null],
  ['nothing before the balance loads', null, SAVED_MILESTONES, FACTS, null],
])('homeLoanProgressLine shows %s', (_name, balance, milestones, loanFacts, expected) => {
  expect(homeLoanProgressLine({ loanFacts, homeLoan: { balance, asOf: null }, milestones })).toBe(expected);
});
