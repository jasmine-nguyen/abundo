// ABU-110 — the Transactions tab on a wide screen (the iPhone Duo's inner screen): tapping a row
// shows its detail beside the list instead of opening a new page; deleting from that pane clears
// the pane without going back; folding to a narrow screen reopens the open transaction full screen.
// Real screen + AppProvider over the fake server; only the window-width check is switched.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { screen, fireEvent, waitFor } from '@testing-library/react-native';
import { txn } from './factory';
import { installFakeServer, seedFeedPage } from './support/fakeServer';
import { useTestQueryClient, refreshInAct } from './support/renderWithQueries';
import { renderWithApp, WithApp } from './support/renderWithApp';
import { resetListTabs } from './support/listTabsScreen';
import { routerSpies, setFocused } from './support/routerMock';
import { pressAlertButton, spyOnAlert } from './support/alertSpy';
import { removeFromAllCopies } from '../transactionCache';

let mockWide = true;
jest.mock('../hooks/useWideLayout', () =>
  require('./support/wideLayoutMock').wideLayoutMockModule(() => mockWide));
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Transactions from '../../app/(tabs)/transactions';

const server = installFakeServer();
useTestQueryClient();

const FEED = '/transactions/feed';
const ROW = txn({ transaction_id: 't1', amount: -42, account_name: 'ANZ' });
const KEEP = txn({ transaction_id: 't2', merchant_name: 'Coles', description: 'COLES', amount: -7, account_name: 'ANZ' });

const detailShown = () => screen.queryByTestId('transaction-delete') !== null;

async function drawAndOpen() {
  const view = await renderWithApp(<Transactions />);
  expect(await screen.findByText('Woolworths')).toBeTruthy();
  fireEvent.press(screen.getByText('Woolworths'));
  return view;
}

const redraw = (view: Awaited<ReturnType<typeof renderWithApp>>) =>
  refreshInAct(() => view.rerender(<WithApp><Transactions /></WithApp>));

beforeEach(() => {
  resetListTabs(server);
  mockWide = true;
  seedFeedPage(server, FEED, [ROW, KEEP]);
});

describe('wide screen', () => {
  const alerts = spyOnAlert();

  it('tapping a row shows its detail beside the list, without opening a new page', async () => {
    await drawAndOpen();

    await waitFor(() => expect(detailShown()).toBe(true));
    expect(screen.getByText('Coles')).toBeTruthy();
    expect(routerSpies.push).not.toHaveBeenCalled();
  });

  it('deleting from the pane removes the charge and clears the pane, without going back', async () => {
    await drawAndOpen();
    await waitFor(() => expect(detailShown()).toBe(true));

    fireEvent.press(screen.getByTestId('transaction-delete'));
    await refreshInAct(() => pressAlertButton(alerts, 'Delete'));

    await waitFor(() => expect(detailShown()).toBe(false));
    expect(server.requests()).toContainEqual({ method: 'DELETE', path: '/transactions/t1', body: undefined });
    expect(screen.queryByText('Woolworths')).toBeNull();
    expect(screen.queryByText('Transaction not found')).toBeNull();
    expect(screen.getByText('Coles')).toBeTruthy();
    expect(routerSpies.back).not.toHaveBeenCalled();
  });

  it('a selected charge that leaves the list (deleted elsewhere, or settled) clears the pane', async () => {
    await drawAndOpen();
    await waitFor(() => expect(detailShown()).toBe(true));

    await refreshInAct(() => { removeFromAllCopies('t1'); });

    await waitFor(() => expect(detailShown()).toBe(false));
    expect(screen.queryByText('Transaction not found')).toBeNull();
  });

  it.each([
    [true, ['/transaction/t1']],
    [false, []],
  ])('folding to a narrow screen with a charge open (tab focused: %p) pushes %j', async (focused, pushed) => {
    const view = await drawAndOpen();
    await waitFor(() => expect(detailShown()).toBe(true));
    setFocused(focused);

    mockWide = false;
    await redraw(view);

    expect(routerSpies.push.mock.calls.map(([href]) => href)).toEqual(pushed);
    expect(detailShown()).toBe(false);
  });
});

it('narrow screen: tapping a row opens its detail page, as today', async () => {
  mockWide = false;
  await drawAndOpen();

  expect(routerSpies.push).toHaveBeenCalledWith('/transaction/t1');
  expect(detailShown()).toBe(false);
});
