// WHIT-702 QA — the shared header text button keeps the exact look and tap area of the old copies.
import { it, expect, jest } from '@jest/globals';
import React from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { HeaderTextButton } from '../components/ui';
import { C, FONT } from '../theme';

// [A1] same style values as the deleted transactions.tsx / ExportButton.tsx copies
it('keeps the old header button size, padding and text style', () => {
  render(<HeaderTextButton label="Select" testID="hdr" onPress={() => {}} />);
  const button = screen.getByTestId('hdr');
  expect(StyleSheet.flatten(button.props.style)).toEqual(
    expect.objectContaining({ height: 40, paddingHorizontal: 8, alignItems: 'flex-end', justifyContent: 'center' }),
  );
  expect(StyleSheet.flatten(screen.getByText('Select').props.style)).toEqual(
    expect.objectContaining({ fontFamily: FONT.body, fontSize: 14.5, fontWeight: '700', color: C.accentSoft }),
  );
});

// [A2] default is not busy: label shows, state reports busy false, tap still fires
it('defaults to not busy and shows the label', () => {
  const onPress = jest.fn();
  render(<HeaderTextButton label="Cancel" testID="hdr" onPress={onPress} />);
  const button = screen.getByTestId('hdr');
  expect(button.props.accessibilityState).toEqual(expect.objectContaining({ busy: false }));
  fireEvent.press(screen.getByText('Cancel'));
  expect(onPress).toHaveBeenCalledTimes(1);
});

// [A3] the hitSlop of 8 the old copies had
it('keeps the 8pt touch margin', () => {
  render(<HeaderTextButton label="Export" testID="hdr" onPress={() => {}} />);
  expect(screen.getByTestId('hdr').props.hitSlop).toBe(8);
});
