// WHIT-771 — RetryButton owns the shared Retry look (the chip that ListStates, DetailStates,
// Insights, Settings, Goals and Budgets used to copy). With no style passed it paints the
// default chip; a caller's style is merged on top, so its keys win and the rest stay default.
import { it, expect, jest } from '@jest/globals';
import React from 'react';
import { StyleSheet } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { RetryButton } from '../components/ui';

const CHIP_BLUE_16 = 'rgba(124,140,255,0.16)';
const ACCENT_SOFT = '#9db3f9';

it('renders the shared Retry chip when the caller passes no style', () => {
  render(<RetryButton onPress={jest.fn()} label="Retry loading it" testID="thing-retry" />);
  const button = StyleSheet.flatten(screen.getByTestId('thing-retry').props.style);
  expect(button).toMatchObject({ paddingVertical: 10, paddingHorizontal: 22, borderRadius: 12, backgroundColor: CHIP_BLUE_16 });
  const text = StyleSheet.flatten(screen.getByText('Retry').props.style);
  expect(text).toMatchObject({ fontSize: 14, fontWeight: '700', color: ACCENT_SOFT });
});

it("lets the caller's style win key by key, keeping the default for the rest", () => {
  render(
    <RetryButton
      onPress={jest.fn()}
      label="Retry loading it"
      testID="thing-retry"
      style={{ backgroundColor: '#000000', paddingVertical: 6 }}
      textStyle={{ color: '#ffffff' }}
    />,
  );
  const button = StyleSheet.flatten(screen.getByTestId('thing-retry').props.style);
  expect(button).toMatchObject({ paddingVertical: 6, paddingHorizontal: 22, borderRadius: 12, backgroundColor: '#000000' });
  const text = StyleSheet.flatten(screen.getByText('Retry').props.style);
  expect(text).toMatchObject({ fontSize: 14, fontWeight: '700', color: '#ffffff' });
});
