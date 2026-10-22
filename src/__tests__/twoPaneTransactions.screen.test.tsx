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
import { TAB_BAR_CLEARANCE } from '../motion/ScrollChromeHeader';

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

  // [A7] the pane sits beside the list, so it has no back arrow.
  it('the pane has no back arrow', async () => {
    await drawAndOpen();
    await waitFor(() => expect(detailShown()).toBe(true));

    expect(screen.queryByLabelText('Back')).toBeNull();
  });

  // [A8] select mode doesn't change on a wide screen; [A9] an unfiled row still opens the picker.
  it('in select mode, or on an unfiled row, a tap does not open the pane', async () => {
    seedFeedPage(server, FEED, [ROW, KEEP, txn({ transaction_id: 't3', merchant_name: 'Cafe', description: 'CAFE', category: null })]);
    await renderWithApp(<Transactions />);
    fireEvent.press(await screen.findByText('Cafe'));
    fireEvent.press(screen.getByText('Select'));
    fireEvent.press(screen.getByText('Woolworths', { includeHiddenElements: true }));

    expect(screen.getByLabelText('Select Woolworths').props.accessibilityState).toEqual({ checked: true });
    expect(detailShown()).toBe(false);
    expect(routerSpies.push).not.toHaveBeenCalled();
  });

  // [A10] switching rows saves the first row's typed note and never shows it on the second.
  it('opening another row saves the note typed in the pane and shows the new row\'s own note', async () => {
    seedFeedPage(server, FEED, [ROW, { ...KEEP, notes: 'weekly shop' }]);
    await drawAndOpen();
    await waitFor(() => expect(detailShown()).toBe(true));
    fireEvent.press(screen.getByTestId('note-add'));
    fireEvent.changeText(screen.getByTestId('note-input'), 'lunch');

    await refreshInAct(() => fireEvent.press(screen.getByText('Coles')));

    expect(server.requests()).toContainEqual({ method: 'PATCH', path: '/transactions/t1', body: { notes: 'lunch' } });
    expect(screen.getByTestId('note-input').props.value).toBe('weekly shop');
  });

  // [A11] folding mid-edit doesn't lose the typed note: it saves, then the charge reopens full screen.
  it('folding with a note typed in the pane saves it', async () => {
    const view = await drawAndOpen();
    await waitFor(() => expect(detailShown()).toBe(true));
    fireEvent.press(screen.getByTestId('note-add'));
    fireEvent.changeText(screen.getByTestId('note-input'), 'lunch');

    mockWide = false;
    await redraw(view);

    expect(server.requests()).toContainEqual({ method: 'PATCH', path: '/transactions/t1', body: { notes: 'lunch' } });
    expect(routerSpies.push).toHaveBeenCalledWith('/transaction/t1');
  });

  // [A12] a failed delete puts the charge back and keeps the pane open for a retry.
  it('a failed delete from the pane keeps the pane open', async () => {
    server.fail('/transactions/t1', 500);
    await drawAndOpen();
    await waitFor(() => expect(detailShown()).toBe(true));

    fireEvent.press(screen.getByTestId('transaction-delete'));
    await refreshInAct(() => pressAlertButton(alerts, 'Delete'));

    await waitFor(() => expect(screen.getByTestId('transaction-delete').props.accessibilityState).toEqual({ disabled: false }));
    expect(detailShown()).toBe(true);
    expect(routerSpies.back).not.toHaveBeenCalled();
  });

  // [A13] the tab bar floats over the tab, pane included: the pane's last row must scroll clear of it,
  // as the list's does.
  it('the pane scrolls its last row clear of the tab bar', async () => {
    await drawAndOpen();
    await waitFor(() => expect(detailShown()).toBe(true));

    const [paneScroll] = screen.UNSAFE_getAllByProps({ automaticallyAdjustKeyboardInsets: true });
    expect(paneScroll.props.contentContainerStyle.paddingBottom).toBeGreaterThanOrEqual(TAB_BAR_CLEARANCE);
  });
});

it('narrow screen: tapping a row opens its detail page, as today', async () => {
  mockWide = false;
  await drawAndOpen();

  expect(routerSpies.push).toHaveBeenCalledWith('/transaction/t1');
  expect(detailShown()).toBe(false);
});
