// WHIT-397 — adversarial gap for the SegmentedControl extraction (pure refactor: any behaviour
// delta is the bug):
//   [A9]  component contract: a `value` that matches NO option renders ZERO selected segments and
//         no active tint (guards the falsy-value / cleared-side path in `value === option.value`).
// WHIT-687: the old [A10]/[A11] render checks of the real Insights toggle colours were deleted (they
// checked looks, not behaviour). The toggle colour is guarded by accentAltToken.logic.test.ts and the
// theme-token code scan instead.
import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import { StyleSheet } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { SegmentedControl } from '../components/SegmentedControl';
import { styleOf } from './support/layout';

// ---- [A9] component contract: value matches no option -------------------------------------------
describe('SegmentedControl — value matches no option', () => {
  const OPTS = [
    { value: 'spending' as const, label: 'Spending', testID: 'seg-spending', activeTint: 'rgba(1,2,3,.16)', activeTextColor: '#f7768e' },
    { value: 'earning' as const, label: 'Earning', testID: 'seg-earning', activeTint: 'rgba(4,5,6,.16)', activeTextColor: '#2ac3de' },
  ];
  const textStyleOf = (label: string) => StyleSheet.flatten(screen.getByText(label).props.style);

  it('[A9] a value matching no option leaves every segment unselected and untinted', () => {
    // A value that matches no option (a cleared/unknown side) must render as a blank — no crash.
    render(<SegmentedControl value="none" onChange={jest.fn()} options={OPTS} />);
    expect(screen.getByTestId('seg-spending').props.accessibilityState.selected).toBe(false);
    expect(screen.getByTestId('seg-earning').props.accessibilityState.selected).toBe(false);
    expect(styleOf(screen.getByTestId('seg-spending')).backgroundColor).toBeUndefined();
    expect(styleOf(screen.getByTestId('seg-earning')).backgroundColor).toBeUndefined();
    // no segment took the bold active weight
    expect(textStyleOf('Spending').fontWeight).toBe('600');
    expect(textStyleOf('Earning').fontWeight).toBe('600');
  });
});
