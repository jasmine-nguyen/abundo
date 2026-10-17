// WHIT-702 — the shared top-bar text button (Select / Cancel / Export) on the ScrollChromeHeader.
import { it, expect, jest } from '@jest/globals';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { HeaderTextButton } from '../components/ui';
import { TITLE_MAX_SCALE } from '../hooks/useLargeText';

it('shows its label as a button and a tap calls onPress', () => {
  const onPress = jest.fn();
  render(
    <HeaderTextButton
      label="Select"
      testID="hdr-select"
      onPress={onPress}
      accessibilityLabel="Select transactions"
    />,
  );
  expect(screen.getByText('Select')).toBeTruthy();
  const button = screen.getByTestId('hdr-select');
  expect(button.props.accessibilityRole).toBe('button');
  expect(screen.getByLabelText('Select transactions')).toBeTruthy();
  fireEvent.press(screen.getByText('Select'));
  expect(onPress).toHaveBeenCalledTimes(1);
});

// ABU-76: at the largest text size the label stops growing at the title cap, so it fits the 40px button.
it('caps the label at the screen-title text size limit', () => {
  render(<HeaderTextButton label="Export" testID="hdr-export" onPress={() => {}} />);
  expect(screen.getByText('Export').props.maxFontSizeMultiplier).toBe(TITLE_MAX_SCALE);
});

it('while busy, swaps the label for a spinner and reports busy', () => {
  render(<HeaderTextButton label="Export" testID="hdr-export" onPress={() => {}} busy />);
  expect(screen.queryByText('Export')).toBeNull();
  const button = screen.getByTestId('hdr-export');
  expect(button.props.accessibilityState).toEqual(expect.objectContaining({ busy: true }));
});
