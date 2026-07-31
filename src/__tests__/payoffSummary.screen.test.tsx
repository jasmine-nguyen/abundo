// WHIT-372 — the extracted shared payoff block. Both the /mortgage hero and the Goals-hub card
// render <PayoffSummary/>; this locks that each variant shows the right eyebrow + the shared
// figures, AND that the per-variant SIZE actually differs (hero 48px figure / card 30px), so a
// mistyped style value in the extraction reddens here rather than only in a screenshot.
import { describe, it, expect } from '@jest/globals';
import React from 'react';
import { StyleSheet } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { PayoffSummary } from '../components/PayoffSummary';

const PROPS = {
  paidOff: 67100,
  paidPctLabel: 13,
  paidPct: 13.42,
  balanceLabel: '$432,900',
  original: 500000,
} as const;

const styleOf = (text: string) => StyleSheet.flatten(screen.getByText(text).props.style);

describe('PayoffSummary', () => {
  it('hero variant: long eyebrow, shared figures, and the hero size tuning verbatim', () => {
    render(<PayoffSummary variant="hero" {...PROPS} />);
    expect(screen.getByText('THE MORTGAGE · PAID DOWN SO FAR')).toBeTruthy();
    expect(screen.getByText('$67,100')).toBeTruthy();
    expect(screen.getByText('13% gone')).toBeTruthy();
    expect(screen.getByText('$432,900 to go')).toBeTruthy();
    expect(screen.getByText('started at $500,000')).toBeTruthy();
    // The exact per-variant figure + eyebrow tuning, so an extraction typo (not just a swapped
    // font size) reddens: hero figure 48/lineHeight 48/letterSpacing −2; eyebrow 12.5, no marginTop.
    const figure = styleOf('$67,100');
    expect(figure.fontSize).toBe(48);
    expect(figure.lineHeight).toBe(48);
    expect(figure.letterSpacing).toBe(-2);
    const eyebrow = styleOf('THE MORTGAGE · PAID DOWN SO FAR');
    expect(eyebrow.fontSize).toBe(12.5);
    expect(eyebrow.marginTop).toBeUndefined();
  });

  it('card variant: short eyebrow (never the hero one), shared figures, and the card size tuning verbatim', () => {
    render(<PayoffSummary variant="card" {...PROPS} />);
    expect(screen.getByText('PAID DOWN SO FAR')).toBeTruthy();
    expect(screen.queryByText('THE MORTGAGE · PAID DOWN SO FAR')).toBeNull();
    expect(screen.getByText('$67,100')).toBeTruthy();
    expect(screen.getByText('13% gone')).toBeTruthy();
    expect(screen.getByText('$432,900 to go')).toBeTruthy();
    expect(screen.getByText('started at $500,000')).toBeTruthy();
    // Card figure 30/letterSpacing −1/flexShrink 1 (no lineHeight); eyebrow 12 with marginTop 15.
    const figure = styleOf('$67,100');
    expect(figure.fontSize).toBe(30);
    expect(figure.letterSpacing).toBe(-1);
    expect(figure.flexShrink).toBe(1);
    const eyebrow = styleOf('PAID DOWN SO FAR');
    expect(eyebrow.fontSize).toBe(12);
    expect(eyebrow.marginTop).toBe(15);
  });
});
