// WHIT-508 — the "Apply my rules" button on the Uncategorized tab.
//
// It is gated on the WHOLE-history count (the number the badge shows), not the loaded-page count:
// after a capped run the loaded page can be empty while hundreds of unfiled charges remain deeper
// in history — exactly when the button is still needed. And it is hidden behind the cold spinner
// and the load-error state like every other control on this screen, so it never renders over
// "Couldn't load your transactions."
// The screen and its data code are real, over the pretend server (WHIT-686).
import { it, expect, jest, beforeEach, describe } from '@jest/globals';
import React from 'react';
import { screen, fireEvent } from '@testing-library/react-native';

const mockSetSheet = jest.fn();
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return {
    ...actual,
    useAppContext: () => ({ openMultiPicker: jest.fn(), showToast: jest.fn(), openPicker: jest.fn(), setSheet: mockSetSheet }),
  };
});
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return { useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]), useRouter: () => ({ push: jest.fn() }) };
});

import Transactions from '../../app/(tabs)/transactions';
import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { GROCERIES_TOP } from './support/categories';
import { useTestQueryClient, renderWithQueries, settle } from './support/renderWithQueries';

const server = installFakeServer();
useTestQueryClient();

const UNCATEGORIZED_FEED = '/transactions/uncategorized/feed';
const COUNT = '/transactions/uncategorized/count';
const unfiled = (id: string) => ({
  transaction_id: id, date: '2026-07-01', authorized_date: '2026-07-01', description: 'COLES',
  merchant_name: 'Coles', amount: -12.5, account_id: 'a1', account_name: 'ANZ', category: null,
  status: 'posted', type: 'PAYMENT', counts_to_budget: true,
});

const BUTTON = 'transactions-apply-rules';

const seedUncategorizedFeed = (transactions: unknown[], nextCursor: string | null = null) =>
  server.seed(UNCATEGORIZED_FEED, { transactions, nextCursor });

/** Render, wait for the first reads, and switch to the Uncategorized tab unless told otherwise. */
async function renderTab(tab: 'all' | 'uncategorized' = 'uncategorized') {
  await renderWithQueries(<Transactions />);
  if (tab === 'all') return;
  fireEvent.press(screen.getByTestId('tab-uncategorized'));
  await settle();
}

beforeEach(() => {
  resetAuth();
  mockSetSheet.mockClear();
  server.seed('/categories', [GROCERIES_TOP]);
  server.seed(COUNT, { count: 5 });
  seedUncategorizedFeed([unfiled('t1')]);
});

describe('the "Apply my rules" button', () => {
  it('shows on the Uncategorized tab when there are unfiled charges', async () => {
    await renderTab();
    expect(screen.getByTestId(BUTTON)).toBeTruthy();
  });

  it('opens the apply-rules sheet when pressed', async () => {
    await renderTab();
    fireEvent.press(screen.getByTestId(BUTTON));
    expect(mockSetSheet).toHaveBeenCalledWith({ mode: 'applyRules' });
  });

  it('is not on the All tab', async () => {
    await renderTab('all');
    expect(screen.getByText('5')).toBeTruthy(); // the count has resolved
    expect(screen.queryByTestId(BUTTON)).toBeNull();
  });

  // "All caught up" — offering a sweep with nothing to sweep is noise.
  it('is gone once the server count resolves to zero', async () => {
    server.seed(COUNT, { count: 0 });
    seedUncategorizedFeed([]);
    await renderTab();
    expect(screen.getByText('All caught up')).toBeTruthy();
    expect(screen.queryByTestId(BUTTON)).toBeNull();
  });

  // The whole-history gate: the loaded page is empty (the rows sit deeper in history), but the
  // badge says 339 remain — which is exactly the state a capped run leaves behind. Fail-on-revert:
  // gate on the local loaded-page count instead and the button vanishes mid-way through the job.
  it('stays visible when the loaded page is empty but history still has unfiled charges', async () => {
    server.seed(COUNT, { count: 339 });
    seedUncategorizedFeed([], 'c1');
    await renderTab();
    expect(screen.getByTestId(BUTTON)).toBeTruthy();
  });

  // Fail-on-revert for the two gates the review added: drop `!showSpinner` / `!showError` and the
  // button renders over the cold spinner or alongside "Couldn't load your transactions."
  it('is hidden during the cold load', async () => {
    await renderTab('all');
    const held = server.hold(UNCATEGORIZED_FEED);
    fireEvent.press(screen.getByTestId('tab-uncategorized'));
    expect(await screen.findByTestId('transactions-loading')).toBeTruthy();
    expect(screen.queryByTestId(BUTTON)).toBeNull();
    held.release();
    await settle();
  });

  it('is hidden while the list is in its error state', async () => {
    server.fail(UNCATEGORIZED_FEED, 500);
    await renderTab();
    expect(screen.getByTestId('transactions-error')).toBeTruthy();
    expect(screen.queryByTestId(BUTTON)).toBeNull();
  });

  // Selection mode is its own task ("re-categorise these 6"); a whole-history sweep alongside it
  // would be two competing bulk actions on one screen.
  it('is hidden in selection mode', async () => {
    await renderTab();
    expect(screen.getByTestId(BUTTON)).toBeTruthy();
    fireEvent.press(screen.getByText('Select'));
    expect(screen.queryByTestId(BUTTON)).toBeNull();
  });
});
