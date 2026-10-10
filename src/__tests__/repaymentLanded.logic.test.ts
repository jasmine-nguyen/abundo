// WHIT-820 — a repayment push lands on Home loan: is the latest repayment new to this phone, and what
// does the "Just landed" card say? Pure input → output over the real milestoneView.
import { describe, it, expect } from '@jest/globals';
import { isRepaymentNew, repaymentLandedView } from '../repaymentLanded';
import { milestoneView } from '../context';
import { makeState } from './factory';
import { SAVED_MILESTONES } from './support/milestonePlan';
import type { Repayment } from '../api';

const TODAY = new Date(2026, 6, 5); // 5 Jul 2026
const SPLIT: Repayment = { amount: 1440, date: '2026-07-01', principal: 1208, interest: 232 };
const TOTAL_ONLY: Repayment = { amount: 1440, date: '2026-07-01', principal: null, interest: null };

describe('isRepaymentNew', () => {
  it.each<[string, string | null, Repayment, boolean]>([
    ['the same repayment was already shown', '2026-07-01@1440', SPLIT, false],
    ['a newer repayment than the one shown', '2026-06-17@1440', SPLIT, true],
    ['an older repayment than the one shown', '2026-07-15@1440', SPLIT, false],
    ['same day, different amount', '2026-07-01@1200', SPLIT, true],
    ['no note yet, repayment within 7 days', null, SPLIT, true],
    ['QA [A5] no note yet, repayment exactly 7 days ago', null, { ...SPLIT, date: '2026-06-28' }, true],
    ['no repayment amount', null, { ...SPLIT, amount: null }, false],
    ['no repayment date', '2026-06-17@1440', { ...SPLIT, date: null }, false],
  ])('%s', (_case, seen, repayment, expected) => {
    expect(isRepaymentNew(seen, repayment, TODAY)).toBe(expected);
  });
});

describe('repaymentLandedView', () => {
  const withBalance = (balance: number | null) =>
    milestoneView(makeState({ milestones: SAVED_MILESTONES, homeLoan: { balance, asOf: null } }), TODAY);

  it.each<[string, Repayment, ReturnType<typeof milestoneView>, { headline: string; detail: string | null; milestoneLine: string | null }]>([
    ['principal known, next milestone ahead', SPLIT, withBalance(250000),
      { headline: '$1,208 off your loan', detail: '$1,440 repayment · $232 interest', milestoneLine: expect.stringMatching(/^Next: Midway · \$50,000 to go/) as unknown as string }],
    ['total only, every milestone reached', TOTAL_ONLY, withBalance(50000),
      { headline: '$1,440 toward your home loan', detail: null, milestoneLine: 'Every milestone reached 🎉' }],
    ['no milestone plan', SPLIT, milestoneView(makeState({ milestones: [], homeLoan: { balance: 250000, asOf: null } }), TODAY),
      { headline: '$1,208 off your loan', detail: '$1,440 repayment · $232 interest', milestoneLine: null }],
    ['balance unknown', SPLIT, withBalance(null),
      { headline: '$1,208 off your loan', detail: '$1,440 repayment · $232 interest', milestoneLine: null }],
  ])('%s', (_case, repayment, milestones, expected) => {
    expect(repaymentLandedView(repayment, milestones)).toEqual(expected);
  });
});
