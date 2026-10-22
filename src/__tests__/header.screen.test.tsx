// ABU-118 — the shared stack/detail title bar (Settings, detail screens, the Duo's transaction pane).
// Turned sideways, its back button and right-side actions sit clear of the rounded corners: the
// sides pad by the left/right safe-area insets on top of the base 20. Different left and right
// insets so a swap is caught.
import { it, expect, jest } from '@jest/globals';
import React from 'react';
import { Text } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { Header } from '../components/Header';
import { styleOf } from './support/layout';

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());
jest.mock('react-native-safe-area-context', () =>
  require('./support/safeAreaMock').safeAreaMockModule({ top: 24, left: 44, right: 59 }));

it('pads the header sides by the left/right safe-area insets', async () => {
  await render(<Header title="Settings" right={<Text>ACTION</Text>} />);
  const wrap = styleOf(screen.getByTestId('header-wrap'));
  expect({ left: wrap.paddingLeft, right: wrap.paddingRight }).toEqual({ left: 64, right: 79 });
});
