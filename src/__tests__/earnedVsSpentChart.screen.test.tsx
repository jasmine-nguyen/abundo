// WHIT-312/324: the Insights "Earned vs Spent" chart — the pure surplus/deficit helper (every
// branch) and the rendered card. react-native is the real preset here (screen project), so bar
// widths read off the fill View's style and the headline/message read off their text nodes.
// WHIT-324: the card shows surplus/deficit only (no budget); both bars share one ruler and the
// smaller bar is floored so a tiny spend stays visible.
import { describe, it, expect } from '@jest/globals';
import React from 'react';
import { StyleSheet } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { EarnedVsSpent, earnedVsSpent } from '../components/EarnedVsSpent';
import { C } from '../theme';

const SURPLUS_MSG = 'Nice, you earned more than you spent this cycle. 🎉';
const DEFICIT_MSG = "oops, a little over this cycle. You've got the next one to balance it out. 💪";
const EVEN_MSG = 'You broke even this cycle.';

const colorOf = (testID: string): string => StyleSheet.flatten(screen.getByTestId(testID).props.style).color;

describe('earnedVsSpent (pure)', () => {
  it('earned above spent → surplus headline, earned bar full width', () => {
    const r = earnedVsSpent(6389, 1723);
    expect(r.leftover).toBe(4666);
    expect(r.overspent).toBe(false);
    expect(r.earnedShare).toBe(1);               // the larger amount fills the track
    expect(r.spentShare).toBeCloseTo(1723 / 6389);
    expect(r.amountLabel).toBe('+$4,666 surplus');
    expect(r.tone).toBe('good');
    expect(r.message).toBe(SURPLUS_MSG);
  });

  it('spent above earned → deficit headline, spent bar full width', () => {
    const r = earnedVsSpent(1000, 1500);
    expect(r.overspent).toBe(true);
    expect(r.spentShare).toBe(1);
    expect(r.earnedShare).toBeCloseTo(1000 / 1500);
    expect(r.amountLabel).toBe('−$500 deficit'); // unicode minus
    expect(r.tone).toBe('bad');
    expect(r.message).toBe(DEFICIT_MSG);
  });

  it('equal earned and spent → broke even (both bars full)', () => {
    const r = earnedVsSpent(1200, 1200);
    expect(r.even).toBe(true);
    expect(r.earnedShare).toBe(1);
    expect(r.spentShare).toBe(1);
    expect(r.amountLabel).toBe('$0');
    expect(r.tone).toBe('neutral');
    expect(r.message).toBe(EVEN_MSG);
  });

  it('income but nothing spent → still a surplus of the whole income', () => {
    const r = earnedVsSpent(2975, 0);
    expect(r.earnedShare).toBe(1);
    expect(r.spentShare).toBe(0);
    expect(r.amountLabel).toBe('+$2,975 surplus');
    expect(r.tone).toBe('good');
  });

  it('spend but no income → a deficit of the whole spend', () => {
    const r = earnedVsSpent(0, 2408);
    expect(r.spentShare).toBe(1);
    expect(r.earnedShare).toBe(0);
    expect(r.amountLabel).toBe('−$2,408 deficit');
    expect(r.tone).toBe('bad');
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

  it('non-finite inputs coerce to 0 (a hand-mocked screen can pass undefined)', () => {
    expect(earnedVsSpent(NaN, 10).earnedShare).toBe(0);
    expect(earnedVsSpent(NaN, 10).tone).toBe('bad');         // 0 earned − 10 spent → deficit
    // @ts-expect-error exercising the undefined path a loose mock could hit
    expect(earnedVsSpent(undefined, undefined).amountLabel).toBe('$0');
  });
});

describe('EarnedVsSpent (render)', () => {
  it('draws both bars, the surplus headline and message', () => {
    render(<EarnedVsSpent earned={6389} spent={1723} testID="evs" />);
    expect(screen.getByText('$6,389')).toBeTruthy();
    expect(screen.getByText('$1,723')).toBeTruthy();
    expect(screen.getByTestId('earned-bar').props.style.width).toBe('100%');            // larger → full
    expect(screen.getByTestId('spent-bar').props.style.width).toBe(`${(1723 / 6389) * 100}%`);
    expect(screen.getByTestId('earned-vs-spent-amount').props.children).toBe('+$4,666 surplus');
    expect(colorOf('earned-vs-spent-amount')).toBe(C.surplus);                          // green headline
    expect(screen.getByTestId('earned-vs-spent-message').props.children).toBe(` — ${SURPLUS_MSG}`);
  });

  it('deficit: the spent bar is full width and the headline is a coral minus', () => {
    render(<EarnedVsSpent earned={1000} spent={1500} testID="evs" />);
    expect(screen.getByTestId('spent-bar').props.style.width).toBe('100%');
    expect(screen.getByTestId('earned-vs-spent-amount').props.children).toBe('−$500 deficit');
    expect(colorOf('earned-vs-spent-amount')).toBe(C.bad);
    expect(screen.getByTestId('earned-vs-spent-message').props.children).toBe(` — ${DEFICIT_MSG}`);
  });

  it('broke even: $0 headline in the neutral colour', () => {
    render(<EarnedVsSpent earned={1200} spent={1200} testID="evs" />);
    expect(screen.getByTestId('earned-bar').props.style.width).toBe('100%');
    expect(screen.getByTestId('spent-bar').props.style.width).toBe('100%');
    expect(screen.getByTestId('earned-vs-spent-amount').props.children).toBe('$0');
    expect(colorOf('earned-vs-spent-amount')).toBe(C.textBright);
  });

  it('a tiny spend against a large income floors to a visible nub, not a hairline', () => {
    render(<EarnedVsSpent earned={6389} spent={30} testID="evs" />);
    // 30/6389 ≈ 0.47% would be near-invisible → floored to the 3% minimum.
    expect(screen.getByTestId('spent-bar').props.style.width).toBe('3%');
    expect(screen.getByTestId('earned-bar').props.style.width).toBe('100%');
  });

  it('a zero-spend bar stays empty (the floor never fills a $0 bar)', () => {
    render(<EarnedVsSpent earned={2975} spent={0} testID="evs" />);
    expect(screen.getByTestId('spent-bar').props.style.width).toBe('0%');
    expect(screen.getByTestId('earned-vs-spent-amount').props.children).toBe('+$2,975 surplus');
  });

  it('renders nothing when there was neither income nor spend', () => {
    render(<EarnedVsSpent earned={0} spent={0} testID="evs" />);
    expect(screen.queryByTestId('evs')).toBeNull();
    expect(screen.queryByTestId('earned-bar')).toBeNull();
  });

  it('has no leftover budget-overlay bits (removed in WHIT-324)', () => {
    render(<EarnedVsSpent earned={6389} spent={1723} testID="evs" />);
    expect(screen.queryByTestId('earned-bar-target')).toBeNull();
    expect(screen.queryByTestId('spent-bar-target')).toBeNull();
    expect(screen.queryByTestId('budgeted-surplus')).toBeNull();
  });

  it('carries an accessible summary of earned, spent, and the surplus line', () => {
    render(<EarnedVsSpent earned={6389} spent={1723} testID="evs" />);
    expect(screen.getByTestId('evs').props.accessibilityLabel).toBe(
      `Earned $6,389, spent $1,723. +$4,666 surplus — ${SURPLUS_MSG}`,
    );
  });
});
