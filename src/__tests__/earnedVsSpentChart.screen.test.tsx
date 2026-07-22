// WHIT-312: the Insights "Earned vs Spent" chart — the pure verdict/share helper (every
// branch) and the rendered card. react-native is the real preset here (screen project), so
// bar widths read off the fill View's style and the verdict reads off its text node.
import { describe, it, expect } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { EarnedVsSpent, earnedVsSpent } from '../components/EarnedVsSpent';

describe('earnedVsSpent (pure)', () => {
  it('earned above spent → leftover verdict, earned bar full width', () => {
    const r = earnedVsSpent(2975, 2408);
    expect(r.leftover).toBe(567);
    expect(r.overspent).toBe(false);
    expect(r.earnedShare).toBe(1);               // the larger amount fills the track
    expect(r.spentShare).toBeCloseTo(2408 / 2975);
    expect(r.verdict).toBe('You have $567 left over');
  });

  it('spent above earned → overspent verdict, spent bar full width', () => {
    const r = earnedVsSpent(1000, 1500);
    expect(r.overspent).toBe(true);
    expect(r.spentShare).toBe(1);
    expect(r.earnedShare).toBeCloseTo(1000 / 1500);
    expect(r.verdict).toBe('You overspent by $500');
  });

  it('equal earned and spent → broke even (both bars full)', () => {
    const r = earnedVsSpent(1200, 1200);
    expect(r.even).toBe(true);
    expect(r.earnedShare).toBe(1);
    expect(r.spentShare).toBe(1);
    expect(r.verdict).toBe('You broke even');
  });

  it('income but nothing spent → "Nothing spent yet"', () => {
    const r = earnedVsSpent(2975, 0);
    expect(r.earnedShare).toBe(1);
    expect(r.spentShare).toBe(0);
    expect(r.verdict).toBe('Nothing spent yet');
  });

  it('spend but no income → "No income recorded yet"', () => {
    const r = earnedVsSpent(0, 2408);
    expect(r.spentShare).toBe(1);
    expect(r.earnedShare).toBe(0);
    expect(r.verdict).toBe('No income recorded yet');
  });

  it('both zero → no shares, no-activity verdict', () => {
    const r = earnedVsSpent(0, 0);
    expect(r.earnedShare).toBe(0);
    expect(r.spentShare).toBe(0);
    expect(r.verdict).toBe('No activity yet');
  });

  it('a sub-cent gap still reads as broke-even; a clear gap does not', () => {
    expect(earnedVsSpent(100, 100.004).even).toBe(true);   // within EPS
    expect(earnedVsSpent(100, 100.02).overspent).toBe(true); // beyond EPS
  });

  it('non-finite inputs coerce to 0 (a hand-mocked screen can pass undefined)', () => {
    expect(earnedVsSpent(NaN, 10).earnedShare).toBe(0);
    expect(earnedVsSpent(NaN, 10).verdict).toBe('No income recorded yet');
    // @ts-expect-error exercising the undefined path a loose mock could hit
    expect(earnedVsSpent(undefined, undefined).verdict).toBe('No activity yet');
  });
});

describe('EarnedVsSpent (render)', () => {
  it('draws both bars with their amounts and the leftover verdict', () => {
    render(<EarnedVsSpent earned={2975} spent={2408} testID="evs" />);
    expect(screen.getByText('$2,975')).toBeTruthy();
    expect(screen.getByText('$2,408')).toBeTruthy();
    expect(screen.getByTestId('earned-bar').props.style.width).toBe('100%');   // larger → full
    expect(screen.getByTestId('earned-vs-spent-verdict').props.children).toBe('You have $567 left over');
  });

  it('overspent: the spent bar is full width and the verdict says so', () => {
    render(<EarnedVsSpent earned={1000} spent={1500} testID="evs" />);
    expect(screen.getByTestId('spent-bar').props.style.width).toBe('100%');
    expect(screen.getByTestId('earned-vs-spent-verdict').props.children).toBe('You overspent by $500');
  });

  it('renders nothing when there was neither income nor spend', () => {
    render(<EarnedVsSpent earned={0} spent={0} testID="evs" />);
    expect(screen.queryByTestId('evs')).toBeNull();
    expect(screen.queryByTestId('earned-bar')).toBeNull();
  });

  it('carries an accessible summary of earned, spent and the verdict', () => {
    render(<EarnedVsSpent earned={2975} spent={2408} testID="evs" />);
    expect(screen.getByTestId('evs').props.accessibilityLabel).toBe('Earned $2,975, spent $2,408. You have $567 left over.');
  });
});
