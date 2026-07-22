// WHIT-314: the budgeted overlay on the Earned-vs-Spent chart — the pure earnedVsSpentBudgeted
// helper (every branch, shared-scale shares, surplus copy) and the rendered target tracks +
// surplus line. The actuals-only path (no `budgeted` prop) must stay the WHIT-312 render.
import { describe, it, expect } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { EarnedVsSpent, earnedVsSpentBudgeted } from '../components/EarnedVsSpent';

// PocketSmith reference: earned 2975 of 3082, spent 2408 of 2438 → $644 budgeted surplus.
const REF = { earned: 2975, spent: 2408, budgetedEarned: 3082, budgetedSpent: 2438 } as const;

describe('earnedVsSpentBudgeted (pure)', () => {
  it('shares are on ONE shared max across all four values', () => {
    const r = earnedVsSpentBudgeted(REF.earned, REF.spent, REF.budgetedEarned, REF.budgetedSpent);
    // budgetedEarned (3082) is the largest → full width; everything else is a fraction of it.
    expect(r.budgetedEarnedShare).toBe(1);
    expect(r.earnedShare).toBeCloseTo(2975 / 3082);
    expect(r.spentShare).toBeCloseTo(2408 / 3082);
    expect(r.budgetedSpentShare).toBeCloseTo(2438 / 3082);
  });

  it('budgeted surplus = budgeted income − budgeted spend, with surplus/shortfall/break-even copy', () => {
    const surplus = earnedVsSpentBudgeted(0, 0, 3082, 2438);
    expect(surplus.budgetedSurplus).toBe(644);
    expect(surplus.surplusLabel).toBe('$644 budgeted surplus');
    expect(earnedVsSpentBudgeted(0, 0, 2000, 2500).budgetedSurplus).toBe(-500);
    expect(earnedVsSpentBudgeted(0, 0, 2000, 2500).surplusLabel).toBe('$500 budgeted shortfall');
    expect(earnedVsSpentBudgeted(0, 0, 2000, 2000).surplusLabel).toBe('Budgeted to break even');
  });

  it('an actual over its budget draws PAST its target (share > targetShare)', () => {
    // spent 3000 vs a 2000 spend budget, no income → max is the 3000 actual.
    const r = earnedVsSpentBudgeted(0, 3000, 0, 2000);
    expect(r.spentShare).toBe(1);
    expect(r.budgetedSpentShare).toBeCloseTo(2000 / 3000);
    expect(r.spentShare).toBeGreaterThan(r.budgetedSpentShare);
  });

  it('coerces non-finite inputs to 0', () => {
    // @ts-expect-error exercising the undefined path a loose caller could hit
    const r = earnedVsSpentBudgeted(undefined, 100, NaN, 200);
    expect(r.earnedShare).toBe(0);
    expect(r.budgetedEarnedShare).toBe(0);
    expect(r.surplusLabel).toBe('$200 budgeted shortfall'); // 0 income budget - 200 spend budget
  });
});

describe('EarnedVsSpent — budgeted overlay (render)', () => {
  const budgeted = { budgetedEarned: REF.budgetedEarned, budgetedSpent: REF.budgetedSpent };

  it('draws both target tracks, the budgeted captions, and the surplus line', () => {
    render(<EarnedVsSpent earned={REF.earned} spent={REF.spent} budgeted={budgeted} testID="evs" />);
    expect(screen.getByTestId('earned-bar-target').props.style.width).toBe('100%');        // 3082 = max
    expect(screen.getByTestId('spent-bar-target').props.style.width).toBe(`${(2438 / 3082) * 100}%`);
    expect(screen.getByText('of $3,082 budgeted')).toBeTruthy();
    expect(screen.getByText('of $2,438 budgeted')).toBeTruthy();
    expect(screen.getByTestId('budgeted-surplus').props.children).toBe('$644 budgeted surplus');
  });

  it('shows the target tracks with empty actual bars at $0 activity (right after payday)', () => {
    render(<EarnedVsSpent earned={0} spent={0} budgeted={budgeted} testID="evs" />);
    expect(screen.getByTestId('evs')).toBeTruthy();                       // not null — the plan is visible
    expect(screen.getByTestId('earned-bar-target').props.style.width).toBe('100%');
    expect(screen.getByTestId('earned-bar').props.style.width).toBe('0%'); // actual empty
    expect(screen.getByTestId('budgeted-surplus').props.children).toBe('$644 budgeted surplus');
  });

  it('over-budget: the coloured actual fill is wider than its target track', () => {
    render(<EarnedVsSpent earned={0} spent={3000} budgeted={{ budgetedEarned: 0, budgetedSpent: 2000 }} testID="evs" />);
    expect(screen.getByTestId('spent-bar').props.style.width).toBe('100%');                  // 3000 = max
    expect(screen.getByTestId('spent-bar-target').props.style.width).toBe(`${(2000 / 3000) * 100}%`);
  });

  it('carries an accessible summary including the budgeted context', () => {
    render(<EarnedVsSpent earned={REF.earned} spent={REF.spent} budgeted={budgeted} testID="evs" />);
    expect(screen.getByTestId('evs').props.accessibilityLabel).toBe(
      'Earned $2,975 of $3,082 budgeted, spent $2,408 of $2,438 budgeted. $644 budgeted surplus.',
    );
  });

  it('spend-only budget: spent gets a target, earned does not, and there is NO false shortfall', () => {
    // budgetedEarned 0 (no income target) → must NOT claim a "budgeted shortfall" for someone
    // who simply didn't budget income. Shows the spend target + the actuals verdict instead.
    render(<EarnedVsSpent earned={500} spent={1500} budgeted={{ budgetedEarned: 0, budgetedSpent: 2000 }} testID="evs" />);
    expect(screen.getByTestId('spent-bar-target')).toBeTruthy();          // spend side has its target
    expect(screen.queryByTestId('earned-bar-target')).toBeNull();          // income side has none
    expect(screen.getByText('of $2,000 budgeted')).toBeTruthy();
    expect(screen.queryByText('of $0 budgeted')).toBeNull();               // no phantom "$0 budgeted" caption
    expect(screen.queryByTestId('budgeted-surplus')).toBeNull();           // no surplus/shortfall line
    expect(screen.getByTestId('earned-vs-spent-verdict').props.children).toBe('You overspent by $1,000');
  });

  it('income-only budget: earned gets a target, spent does not, and there is NO false surplus', () => {
    render(<EarnedVsSpent earned={2000} spent={800} budgeted={{ budgetedEarned: 5000, budgetedSpent: 0 }} testID="evs" />);
    expect(screen.getByTestId('earned-bar-target')).toBeTruthy();
    expect(screen.queryByTestId('spent-bar-target')).toBeNull();
    expect(screen.getByText('of $5,000 budgeted')).toBeTruthy();
    expect(screen.queryByTestId('budgeted-surplus')).toBeNull();
    expect(screen.getByTestId('earned-vs-spent-verdict').props.children).toBe('You have $1,200 left over');
  });

  it('without the budgeted prop it is the WHIT-312 actuals-only render (no tracks, no surplus)', () => {
    render(<EarnedVsSpent earned={2975} spent={2408} testID="evs" />);
    expect(screen.queryByTestId('earned-bar-target')).toBeNull();
    expect(screen.queryByTestId('budgeted-surplus')).toBeNull();
    expect(screen.getByTestId('earned-vs-spent-verdict').props.children).toBe('You have $567 left over');
  });
});
