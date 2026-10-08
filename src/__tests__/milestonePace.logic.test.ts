// WHIT-822 — the milestones card's pace line: the repayment needed each payday to bring the
// balance down to the next milestone's target by its date, interest included.
import { it, expect } from '@jest/globals';
import { milestonePace, milestoneView, type LoanFacts } from '../context';
import type { PayCycle } from '../api';
import { LOAN_FACTS, EMPTY_LOAN_FACTS } from './factory';
import { SAVED_MILESTONES } from './support/milestonePlan';

// 8 Oct 2026 → next milestone 'Midway' ($200,000 by Jan 2027) is 3 whole months away.
const TODAY = new Date(2026, 9, 8);
const FORTNIGHTLY: PayCycle = { length: 14, last_pay_date: '2026-10-02' };
const WEEKLY: PayCycle = { length: 7, last_pay_date: '2026-10-02' };
const MONTHLY: PayCycle = { length: 30, last_pay_date: '2026-10-02' };

// $275,000 owing at 5.74%: $26,196.21 a month for 3 months lands exactly on $200,000.
// Per payday = monthly × 12 ÷ paydays per year (26 fortnightly, 52 weekly, 12 monthly).
it.each<[string, number, LoanFacts, PayCycle | null, Date, string | null]>([
  ['fortnightly', 275000, LOAN_FACTS, FORTNIGHTLY, TODAY, '$12,091 per payday to hit Jan 2027'],
  ['weekly', 275000, LOAN_FACTS, WEEKLY, TODAY, '$6,045 per payday to hit Jan 2027'],
  ['monthly', 275000, LOAN_FACTS, MONTHLY, TODAY, '$26,196 per payday to hit Jan 2027'],
  ['0% rate is straight-line', 275000, { ...LOAN_FACTS, ratePct: 0 }, FORTNIGHTLY, TODAY, '$11,538 per payday to hit Jan 2027'],
  ['every milestone reached', 90000, LOAN_FACTS, FORTNIGHTLY, TODAY, null],
  ['loan details not set up', 275000, EMPTY_LOAN_FACTS, FORTNIGHTLY, TODAY, null],
  ['no pay cycle', 275000, LOAN_FACTS, null, TODAY, null],
  ['next milestone is due this month', 275000, LOAN_FACTS, FORTNIGHTLY, new Date(2027, 0, 5), null],
])('pace line: %s', (_case, balance, loanFacts, payCycle, today, expected) => {
  const m = milestoneView({ loanFacts, homeLoan: { balance, asOf: null }, milestones: SAVED_MILESTONES }, today);
  expect(milestonePace(m, loanFacts, payCycle, today)).toBe(expected);
});
