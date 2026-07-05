// WHIT-176 — the Settings "Log out" row must actually END the session (call
// signOut from src/auth), not merely navigate. Before the fix it was a bare
// router.replace('/'), which left the session intact and the auth gate bounced the
// still-authed user back into the tabs — no working log out, and no escape from a
// broken session. Fail-on-revert: reverting to router.replace('/') alone drops the
// signOut() call and this test fails. Router + auth + context mocked.
import { it, expect, jest } from '@jest/globals';
import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ replace: mockReplace, push: jest.fn() }) }));

const mockSignOut = jest.fn(async () => {});
jest.mock('../../src/auth', () => ({ signOut: () => mockSignOut() }));

// Minimal context so the screen renders headlessly (it only reads a few fields).
jest.mock('../../src/context', () => ({
  loanFactsReady: () => false,
  useAppContext: () => ({
    categories: [],
    rules: [],
    cycleName: () => 'Fortnightly',
    loanFacts: {},
    alerts: true,
    toggleAlerts: jest.fn(),
    setSheet: jest.fn(),
  }),
}));

import Settings from '../../app/(tabs)/settings';

it('Log out calls signOut() and returns to the login screen', () => {
  const { getByTestId } = render(<Settings />);
  fireEvent.press(getByTestId('settings-logout'));
  expect(mockSignOut).toHaveBeenCalledTimes(1);
  expect(mockReplace).toHaveBeenCalledWith('/');
});
