// WHIT-312/324: the Insights "Earned vs Spent" chart — the pure surplus/deficit helper (every
// branch) and the rendered card. react-native is the real preset here (screen project), so bar
// widths read off the fill View's style and the headline reads off its text node.
// WHIT-324: the card shows surplus/deficit only (no budget); both bars share one ruler and the
// smaller bar is floored so a tiny spend stays visible.
import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { EarnedVsSpent, earnedVsSpent } from '../components/EarnedVsSpent';
import { styleOf } from './support/layout';

describe('earnedVsSpent (pure)', () => {
  it('earned above spent → surplus headline, earned bar full width', () => {
    const r = earnedVsSpent(6389, 1723);
    expect(r.leftover).toBe(4666);
    expect(r.overspent).toBe(false);
    expect(r.earnedShare).toBe(1);               // the larger amount fills the track
    expect(r.spentShare).toBeCloseTo(1723 / 6389);
    expect(r.amountLabel).toBe('+$4,666 surplus');
    expect(r.tone).toBe('good');
  });

  it('spent above earned → deficit headline, spent bar full width', () => {
    const r = earnedVsSpent(1000, 1500);
    expect(r.overspent).toBe(true);
    expect(r.spentShare).toBe(1);
    expect(r.earnedShare).toBeCloseTo(1000 / 1500);
    expect(r.amountLabel).toBe('−$500 deficit'); // unicode minus
    expect(r.tone).toBe('bad');
  });

  it('equal earned and spent → broke even (both bars full)', () => {
    const r = earnedVsSpent(1200, 1200);
    expect(r.even).toBe(true);
    expect(r.earnedShare).toBe(1);
    expect(r.spentShare).toBe(1);
    expect(r.amountLabel).toBe('$0');
    expect(r.tone).toBe('neutral');
  });

  it('both zero → no shares, broke-even headline', () => {
    const r = earnedVsSpent(0, 0);
    expect(r.earnedShare).toBe(0);
    expect(r.spentShare).toBe(0);
    expect(r.amountLabel).toBe('$0');
    expect(r.tone).toBe('neutral');
  });

  it('a sub-dollar gap reads as broke-even (matches the $0 the card shows); a whole-dollar gap does not', () => {
    // Classification tracks the rounded dollar amount, so anything that displays as "$0" is even —
    // no contradictory "+$0 surplus". A real dollar gap still reads as a deficit.
    expect(earnedVsSpent(100, 100.3).even).toBe(true);       // −$0.30 → shows $0 → broke even
    expect(earnedVsSpent(100.3, 100).even).toBe(true);       // +$0.30 → shows $0 → broke even
    expect(earnedVsSpent(100, 101).overspent).toBe(true);    // −$1 → a real deficit
  });
});

// ABU-61: the message names the selected cycle (0 = this, 1 = last) in every outcome, and the
// overspend line is capitalised without "a little".
describe('earnedVsSpent message names the selected cycle', () => {
  it.each([
    [3000, 1000, 0, 'Nice, you earned more than you spent this cycle. 🎉'],
    [3000, 1000, 1, 'Nice, you earned more than you spent last cycle. 🎉'],
    [1000, 1500, 0, "Oops, over this cycle. You've got the next one to balance it out. 💪"],
    [1000, 1500, 1, "Oops, over last cycle. You've got the next one to balance it out. 💪"],
    [1200, 1200, 0, 'You broke even this cycle.'],
    [1200, 1200, 1, 'You broke even last cycle.'],
  ])('earned %d, spent %d, cycle %d → %s', (earned, spent, cycle, message) => {
    expect(earnedVsSpent(earned, spent, cycle).message).toBe(message);
  });
});

describe('EarnedVsSpent (render)', () => {
  it('draws both bars and the surplus headline', () => {
    render(<EarnedVsSpent earned={6389} spent={1723} cycle={0} testID="evs" />);
    expect(screen.getByText('$6,389')).toBeTruthy();
    expect(screen.getByText('$1,723')).toBeTruthy();
    expect(styleOf(screen.getByTestId('earned-bar')).width).toBe('100%');            // larger → full
    expect(styleOf(screen.getByTestId('spent-bar')).width).toBe(`${(1723 / 6389) * 100}%`);
    expect(screen.getByTestId('earned-vs-spent-amount').props.children).toBe('+$4,666 surplus');
  });

  it('a tiny spend against a large income floors to a visible nub, not a hairline', () => {
    render(<EarnedVsSpent earned={6389} spent={30} cycle={0} testID="evs" />);
    // 30/6389 ≈ 0.47% would be near-invisible → floored to the 3% minimum.
    expect(styleOf(screen.getByTestId('spent-bar')).width).toBe('3%');
    expect(styleOf(screen.getByTestId('earned-bar')).width).toBe('100%');
  });

  it('a zero-spend bar stays empty (the floor never fills a $0 bar)', () => {
    render(<EarnedVsSpent earned={2975} spent={0} cycle={0} testID="evs" />);
    expect(styleOf(screen.getByTestId('spent-bar')).width).toBe('0%');
    expect(screen.getByTestId('earned-vs-spent-amount').props.children).toBe('+$2,975 surplus');
  });

  it('renders nothing when there was neither income nor spend', () => {
    render(<EarnedVsSpent earned={0} spent={0} cycle={0} testID="evs" />);
    expect(screen.queryByTestId('evs')).toBeNull();
    expect(screen.queryByTestId('earned-bar')).toBeNull();
  });
});
