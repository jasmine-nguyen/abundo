// WHIT-312 (qa gaps) — the Earned-vs-Spent card, adversarial render cases the implementer's
// earnedVsSpentChart.screen.test.tsx doesn't lock: the BROKE-EVEN render at screen level (it
// only pins even in the pure helper), very LARGE amounts (formatting + a valid bar-width
// string), and a sub-cent earned with no spend. Real RN preset (screen project), so widths
// read off the fill View's style and text reads off the rendered nodes.
import { describe, it, expect } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { EarnedVsSpent } from '../components/EarnedVsSpent';

describe('EarnedVsSpent — render gaps (WHIT-312)', () => {
  // [A11] broke-even at the SCREEN level: both bars full, the verdict reads "You broke even".
  it('broke even renders both bars full width with the broke-even verdict', () => {
    render(<EarnedVsSpent earned={1200} spent={1200} testID="evs" />);
    expect(screen.getByTestId('earned-bar').props.style.width).toBe('100%');
    expect(screen.getByTestId('spent-bar').props.style.width).toBe('100%');
    expect(screen.getByTestId('earned-vs-spent-verdict').props.children).toBe('You broke even');
  });

  // [A12] very large amounts: grouped currency formatting survives and the smaller bar's
  // width is a finite, in-range percent string (not NaN/Infinity), the larger stays 100%.
  it('formats large amounts and keeps the proportional bar a valid width', () => {
    render(<EarnedVsSpent earned={12_345_678} spent={1_000_000} testID="evs" />);
    expect(screen.getByText('$12,345,678')).toBeTruthy();
    expect(screen.getByText('$1,000,000')).toBeTruthy();
    expect(screen.getByTestId('earned-bar').props.style.width).toBe('100%'); // earned larger → full
    const spentW = screen.getByTestId('spent-bar').props.style.width as string;
    const pct = Number(spentW.replace('%', ''));
    expect(Number.isFinite(pct)).toBe(true);
    expect(pct).toBeGreaterThan(0);
    expect(pct).toBeLessThanOrEqual(100);
  });

  // [A13] a sub-cent earning with nothing spent still renders (not both-zero → not null) and
  // reads "Nothing spent yet" — the screen gate is earned>0, so the card must cope with a
  // value that rounds to $0 in the label without collapsing to the both-empty null branch.
  it('renders (not null) for a sub-cent earning with no spend', () => {
    render(<EarnedVsSpent earned={0.004} spent={0} testID="evs" />);
    expect(screen.getByTestId('evs')).toBeTruthy();
    expect(screen.getByTestId('earned-vs-spent-verdict').props.children).toBe('Nothing spent yet');
  });
});
