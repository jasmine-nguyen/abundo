import { it, expect } from '@jest/globals';
import React from 'react';
import { Text } from 'react-native';
import { render, screen } from '@testing-library/react-native';

it('renders a react-native Text node (preset smoke test)', () => {
  render(<Text>hello</Text>);
  expect(screen.getByText('hello')).toBeTruthy();
});
