// WHIT-495 — GAP (plan-noted edge): the header gear stays in the Transactions header while the
// screen is in multi-select mode (the shared header draws the gear itself, WHIT-841, so no tab
// can hide it). Tapping it must push /settings WITHOUT tearing down the in-progress selection, so
// returning lands the user back in selection with their picks intact. settingsGear covers the
// gear in the DEFAULT state only.
// Fail-on-revert: make the header hide the gear while selecting → getByLabelText('Settings')
// throws → this goes RED.
// Runs over the fake server: the real useTransactionsScreenData reads the seeded feed.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { screen, fireEvent } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { routerSpies, resetRouter } from './support/routerMock';

jest.mock('../auth', () => require('./support/authMock').authMockModule());

const mockOpenMultiPicker = jest.fn();
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => ({ openPicker: () => {}, openMultiPicker: mockOpenMultiPicker })));

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Transactions from '../../app/(tabs)/transactions';

const server = installFakeServer();
useTestQueryClient();

const charge = {
  transaction_id: 'c1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'COFFEE', merchant_name: 'Cafe', amount: -5, account_id: 'a1',
  account_name: 'ANZ', category: null, status: 'posted', type: 'purchase', counts_to_budget: true,
};

beforeEach(() => {
  resetRouter();
  mockOpenMultiPicker.mockClear();
  resetAuth();
  server.seed('/transactions/feed', { transactions: [charge], nextCursor: null });
  server.seed('/categories', []);
  server.seed('/transactions/uncategorized/count', { count: 1 });
});

it('keeps the gear reachable in selection mode: tapping it pushes /settings and leaves the selection intact', async () => {
  await renderWithQueries(<Transactions />);
  fireEvent.press(screen.getByText('Select'));
  fireEvent.press(screen.getByLabelText('Select Cafe'));
  expect(screen.getByText('1 selected')).toBeTruthy();

  // The gear coexists with the selection UI and taps without tearing it down.
  fireEvent.press(screen.getByLabelText('Settings'));
  expect(routerSpies.push).toHaveBeenCalledWith('/settings');
  // Selection survives the navigation away (component is not unmounted on a root push).
  expect(screen.getByText('1 selected')).toBeTruthy();
  expect(screen.getByLabelText('Re-categorize selected transactions')).toBeTruthy();
});
