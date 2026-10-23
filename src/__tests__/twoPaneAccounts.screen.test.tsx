// ABU-111 — the Accounts tab on a wide screen (the iPhone Duo's inner screen): tapping an account
// shows its balance and transactions beside the list instead of opening a new page; folding to a
// narrow screen reopens the open account full screen. Real screen + AppProvider over the fake
// server; only the window-width check is switched.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { scrollPaddingBottomAround } from './support/layout';
import { screen, fireEvent, waitFor } from '@testing-library/react-native';
import { txn } from './factory';
import { installFakeServer, seedFeedPage } from './support/fakeServer';
import { useTestQueryClient, refreshInAct } from './support/renderWithQueries';
import { renderWithApp, WithApp } from './support/renderWithApp';
import { resetListTabs } from './support/listTabsScreen';
import { routerSpies, setFocused } from './support/routerMock';
import { accountBalance } from './support/accountBalance';
import { TAB_BAR_CLEARANCE } from '../motion/ScrollChromeHeader';

let mockWide = true;
jest.mock('../hooks/useWideLayout', () =>
  require('./support/wideLayoutMock').wideLayoutMockModule(() => mockWide));
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Accounts from '../../app/(tabs)/accounts';

const server = installFakeServer();
useTestQueryClient();

const FEED = '/transactions/feed';

const detailShown = () => screen.queryByTestId('account-balance') !== null;
const card = () => screen.getByLabelText(/^ANZ, /);

async function drawAndOpen() {
  const view = await renderWithApp(<Accounts />);
  await fireEvent.press(await screen.findByLabelText(/^ANZ, /));
  return view;
}

beforeEach(() => {
  resetListTabs(server);
  mockWide = true;
  seedFeedPage(server, FEED, [txn({ transaction_id: 't1', account_id: 'a1', account_name: 'ANZ' })]);
  server.seed('/accounts/balances', [accountBalance({ account_id: 'a1', amount: 1234.5 })]);
});

describe('wide screen', () => {
  it('tapping an account shows its detail beside the list: highlighted card, no new page, no back arrow, clear of the tab bar', async () => {
    await drawAndOpen();

    await waitFor(() => expect(detailShown()).toBe(true));
    expect(routerSpies.push).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Back')).toBeNull();
    expect(card().props.accessibilityState).toEqual(expect.objectContaining({ selected: true }));

    expect(scrollPaddingBottomAround(screen.getByTestId('account-balance'))).toBeGreaterThanOrEqual(TAB_BAR_CLEARANCE);
  });

  // [A1]
  it('before any tap the pane shows the "Select an account" prompt', async () => {
    await renderWithApp(<Accounts />);
    await screen.findByLabelText(/^ANZ, /);

    expect(screen.getByText('Select an account')).toBeTruthy();
    expect(detailShown()).toBe(false);
  });

  // [A2]
  it('tapping another account switches the pane and moves the highlight to it', async () => {
    seedFeedPage(server, FEED, [
      txn({ transaction_id: 't1', account_id: 'a1', account_name: 'ANZ' }),
      txn({ transaction_id: 't2', account_id: 'a2', account_name: 'Westpac' }),
    ]);
    server.seed('/accounts/balances', [
      accountBalance({ account_id: 'a1', amount: 1234.5 }),
      accountBalance({ account_id: 'a2', amount: 77.25 }),
    ]);
    await drawAndOpen();
    await waitFor(() => expect(detailShown()).toBe(true));

    await fireEvent.press(screen.getByLabelText(/^Westpac, /));

    await waitFor(() => expect(screen.getByTestId('account-balance')).toHaveTextContent(/77\.25/));
    expect(card().props.accessibilityState).toEqual(expect.objectContaining({ selected: false }));
    expect(screen.getByLabelText(/^Westpac, /).props.accessibilityState).toEqual(expect.objectContaining({ selected: true }));
    expect(routerSpies.push).not.toHaveBeenCalled();
  });

  it.each([
    [true, ['/account/a1']],
    [false, []],
  ])('folding to a narrow screen with an account open (tab focused: %p) pushes %j', async (focused, pushed) => {
    const view = await drawAndOpen();
    await waitFor(() => expect(detailShown()).toBe(true));
    setFocused(focused);

    mockWide = false;
    await refreshInAct(() => view.rerender(<WithApp><Accounts /></WithApp>));

    expect(routerSpies.push.mock.calls.map(([href]) => href)).toEqual(pushed);
    expect(detailShown()).toBe(false);
  });

  it('the home loan pane\'s payoff link still opens the Home loan screen full screen', async () => {
    server.seed('/accounts/balances', [accountBalance({ account_id: 'a1', amount: -500000, available_balance: 0, account_type: 'mortgage' })]);
    await drawAndOpen();

    await fireEvent.press(await screen.findByTestId('account-payoff-link'));

    expect(routerSpies.push.mock.calls.map(([href]) => href)).toEqual(['/mortgage']);
  });
});

it('narrow screen: tapping an account opens its detail page, as today', async () => {
  mockWide = false;
  await drawAndOpen();

  expect(routerSpies.push).toHaveBeenCalledWith('/account/a1');
  expect(detailShown()).toBe(false);
});
