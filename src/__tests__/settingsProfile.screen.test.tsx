// WHIT-180 — the Settings profile card shows the REAL signed-in identity
// (getCurrentUser), not the "Jordan Diaz" mock. Fail-on-revert: restoring the
// hard-coded mock fails these. ../../src/auth + context + router mocked.
import { it, expect, jest } from '@jest/globals';
import React from 'react';
import { render } from '@testing-library/react-native';

let mockUser: { email?: string; name?: string; picture?: string } | null = null;
jest.mock('../../src/auth', () => ({ signOut: jest.fn(), getCurrentUser: () => mockUser }));
jest.mock('expo-router', () => ({ useRouter: () => ({ replace: jest.fn(), push: jest.fn() }), useFocusEffect: () => {} }));
// WHIT-191a: the categories count + loan-facts status now come from a query composite.
jest.mock('../../src/queries', () => ({
  useSettingsScreenData: () => ({ categoriesCount: 0, loanReady: false, isLoading: false, isError: false, refetch: jest.fn(), refetchStale: jest.fn() }),
  useRulesScreenData: () => ({ rules: [], isLoading: false, isError: false, refetch: jest.fn(), refetchStale: jest.fn() }),
  usePayCycle: () => ({ payCycle: { length: 14, last_pay_date: '2024-01-03' }, cycleLen: 14, daysLeft: 7, cycleName: () => 'Fortnightly', isLoading: false, isError: false }),
}));
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

it('shows the real name + email (Google login), not the mock', () => {
  mockUser = { email: 'me.jasminenguyen@gmail.com', name: 'Jasmine Nguyen' };
  const { getByText, queryByText } = render(<Settings />);
  expect(getByText('Jasmine Nguyen')).toBeTruthy();
  expect(getByText('me.jasminenguyen@gmail.com')).toBeTruthy();
  expect(queryByText('Jordan Diaz')).toBeNull();
  expect(queryByText('jordan@whittle.app')).toBeNull();
});

it('shows just the email when there is no name (native password user)', () => {
  mockUser = { email: 'me.jasminenguyen@gmail.com' };
  const { getByText, queryByText } = render(<Settings />);
  expect(getByText('me.jasminenguyen@gmail.com')).toBeTruthy();
  expect(queryByText('Jordan Diaz')).toBeNull();
});
