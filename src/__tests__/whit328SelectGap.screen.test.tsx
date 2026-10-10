// WHIT-328 — GAP: the single-tap "not tappable" gate only blocks the LIST tap. In SELECTION mode
// on the All tab, a not-in-budget uncategorized charge is still selectable and can be handed to
// the bulk picker (openMultiPicker). This pins that reachable path — see the ranked critique for
// whether it's acceptable (the user explicitly opts into selection mode) vs a real leak.
// The screen and its data code are real, over the pretend server (WHIT-686).
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { screen, fireEvent } from '@testing-library/react-native';

const mockOpenMultiPicker = jest.fn();
jest.mock('../context', () =>
  require('./support/contextMock').realContextWith(() => ({ openPicker: () => {}, openMultiPicker: mockOpenMultiPicker })),
);
jest.mock('../auth', () => require('./support/authMock').authMockModule());

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Transactions from '../../app/(tabs)/transactions';
import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient, renderWithQueries } from './support/renderWithQueries';

const server = installFakeServer();
useTestQueryClient();

// A not-in-budget uncategorized transfer: null category, counts_to_budget false.
const transfer = {
  transaction_id: 'xfer1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'INTERNAL TRANSFER', merchant_name: 'Internal Transfer', amount: -500, account_id: 'a1',
  account_name: 'ANZ', category: null, status: 'posted', type: 'transfer', counts_to_budget: false,
};

beforeEach(() => {
  resetAuth();
  mockOpenMultiPicker.mockClear();
  server.seed('/transactions/feed', { transactions: [transfer], nextCursor: null });
});

it('a not-in-budget uncategorized transfer is still bulk-selectable on the All tab and handed to the picker', async () => {
  await renderWithQueries(<Transactions />);
  // WHIT-330: the transfer now also shows on the Uncategorized tab, but this test exercises the
  // All-tab selection path specifically.
  fireEvent.press(screen.getByText('Select'));
  fireEvent.press(screen.getByLabelText('Select Internal Transfer'));
  expect(screen.getByText('1 selected')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Re-categorise selected transactions'));
  expect(mockOpenMultiPicker).toHaveBeenCalledWith(['xfer1']);
});
