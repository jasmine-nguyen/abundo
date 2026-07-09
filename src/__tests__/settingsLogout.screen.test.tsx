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
jest.mock('expo-router', () => ({ useRouter: () => ({ replace: mockReplace, push: jest.fn() }), useFocusEffect: () => {} }));

const mockSignOut = jest.fn(async () => {});
// WHIT-180: Settings now also reads getCurrentUser for the profile card.
jest.mock('../../src/auth', () => ({ signOut: () => mockSignOut(), getCurrentUser: () => null }));

// WHIT-191a: the categories count + loan-facts status now come from a query composite.
jest.mock('../../src/queries', () => ({
  useSettingsScreenData: () => ({ categoriesCount: 0, loanReady: false, categoriesError: false, loanReadyError: false, isLoading: false, refetch: jest.fn(), refetchStale: jest.fn() }),
  useRulesScreenData: () => ({ rules: [], isLoading: false, isError: false, rulesError: false, refetch: jest.fn(), refetchStale: jest.fn() }),
  usePayCycle: () => ({ payCycle: { length: 14, last_pay_date: '2024-01-03' }, cycleLen: 14, daysLeft: 7, cycleName: () => 'Fortnightly', isLoading: false, isError: false }),
}));

// Minimal context so the screen renders headlessly (rules/pay-cycle/alerts stay on the store).
jest.mock('../../src/context', () => ({
  useAppContext: () => ({
    rules: [],
    cycleName: () => 'Fortnightly',
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
