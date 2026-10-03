// WHIT-711 — the shared tinted 40x40 square header icon button (Budgets/Goals/Rules "+", Settings gear).
import { it, expect, jest } from '@jest/globals';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { HeaderIconButton } from '../components/ui';

function glyphSizes(): number[] {
  return screen.UNSAFE_root
    .findAll((node) => typeof node.props.xml === 'string')
    .map((node) => node.props.width as number);
}

it('is an accessible button with its label and a 56x56 touch area, and a tap calls onPress once', () => {
  const onPress = jest.fn();
  render(
    <HeaderIconButton icon="plus" testID="add-thing" accessibilityLabel="Add budget" onPress={onPress} />,
  );
  const button = screen.getByTestId('add-thing');
  expect(button.props.accessibilityRole).toBe('button');
  expect(button.props.hitSlop).toBe(8);
  fireEvent.press(screen.getByLabelText('Add budget'));
  expect(onPress).toHaveBeenCalledTimes(1);
  expect(glyphSizes()).toContain(22);
});

it('draws the icon at the given iconSize', () => {
  render(
    <HeaderIconButton icon="navSettings" iconSize={20} accessibilityLabel="Settings" onPress={() => {}} />,
  );
  expect(screen.getByLabelText('Settings')).toBeTruthy();
  expect(glyphSizes()).toContain(20);
  expect(glyphSizes()).not.toContain(22);
});
