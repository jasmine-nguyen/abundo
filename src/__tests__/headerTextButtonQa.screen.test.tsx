// WHIT-702 QA — the shared header text button shows its label and fires its tap when not busy.
import { it, expect, jest } from '@jest/globals';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { HeaderTextButton } from '../components/ui';

// [A2] default is not busy: label shows, state reports busy false, tap still fires
it('defaults to not busy and shows the label', () => {
  const onPress = jest.fn();
  render(<HeaderTextButton label="Cancel" testID="hdr" onPress={onPress} />);
  const button = screen.getByTestId('hdr');
  expect(button.props.accessibilityState).toEqual(expect.objectContaining({ busy: false }));
  fireEvent.press(screen.getByText('Cancel'));
  expect(onPress).toHaveBeenCalledTimes(1);
});
