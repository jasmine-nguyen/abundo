// The paged Uncategorized tab's `showUncategorizedMore` affordance (transactions.tsx). The core
// positive states (More to load / Nothing to show yet) and the not-on-All / All-caught-up cases are
// locked in uncategorizedMoreState.screen.test.tsx. This suite covers the SUPPRESSION edges: the
// affordance must never co-render with the "No matches" search state, the cold spinner, the error
// state, or flash before the count resolves.
// The screen and its data code are real, over the pretend server (WHIT-686).
import { it, expect, jest, beforeEach, describe } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import { RefreshControl } from 'react-native';

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return {
    ...actual,
    useAppContext: () => ({ openMultiPicker: jest.fn(), showToast: jest.fn(), openPicker: jest.fn() }),
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
import { useTestQueryClient, renderWithQueries, WithQueries, settle, loaded } from './support/renderWithQueries';
import { uncategorizedFeedKey } from '../queries';
import { GROCERIES_RECORD } from './support/categories';

const server = installFakeServer();
useTestQueryClient();

const UNCATEGORIZED_FEED = '/transactions/uncategorized/feed';
const COUNT = '/transactions/uncategorized/count';
const MORE = 'transactions-uncategorized-more';

const seedUncategorizedFeed = (nextCursor: string | null) => server.seed(UNCATEGORIZED_FEED, { transactions: [], nextCursor });

async function renderTab() {
  const view = await renderWithQueries(<Transactions />);
  fireEvent.press(screen.getByTestId('tab-uncategorized'));
  await settle();
  return view;
}

beforeEach(() => {
  resetAuth();
  server.seed('/categories', [GROCERIES_RECORD]);
});

describe('Uncategorized tab — "more to load" affordance suppression edges', () => {
  // A search query suppresses it — the "No matches" state owns a search miss, not this affordance.
  it('does not render while a search query is active (No matches owns that)', async () => {
    server.seed(COUNT, { count: 639 });
    seedUncategorizedFeed('c1');
    await renderTab();
    expect(screen.getByTestId(MORE)).toBeTruthy(); // shown before the search

    fireEvent.changeText(screen.getByPlaceholderText('Search transactions'), 'zzzz');
    expect(screen.queryByTestId(MORE)).toBeNull();

    await waitFor(() => expect(server.sentUnder('GET', '/transactions/search')).toHaveLength(1));
    expect(await screen.findByText('No matches')).toBeTruthy();
    expect(screen.queryByTestId(MORE)).toBeNull();
  });

  // Cold load (empty + loading) shows the spinner, not this affordance.
  it('does not render during a cold load (the spinner owns it)', async () => {
    server.seed(COUNT, { count: 639 });
    seedUncategorizedFeed('c1');
    await renderWithQueries(<Transactions />);
    const held = server.hold(UNCATEGORIZED_FEED);
    fireEvent.press(screen.getByTestId('tab-uncategorized'));
    expect(await screen.findByTestId('transactions-loading')).toBeTruthy();
    expect(screen.queryByTestId(MORE)).toBeNull();
    held.release();
    await settle();
  });

  // An errored empty list shows the inline error, not this affordance.
  it('does not render on an errored empty list (the error state owns it)', async () => {
    server.seed(COUNT, { count: 639 });
    server.fail(UNCATEGORIZED_FEED, 500);
    await renderTab();
    expect(screen.getByTestId('transactions-error')).toBeTruthy();
    expect(screen.queryByTestId(MORE)).toBeNull();
  });

  // Count still loading with no more pages → neither hasMore nor serverCount>0, so it stays
  // hidden (no flash before the count resolves).
  it('does not render while the count is still loading and there are no more pages', async () => {
    const held = server.hold(COUNT);
    seedUncategorizedFeed(null);
    render(<WithQueries><Transactions /></WithQueries>);
    fireEvent.press(screen.getByTestId('tab-uncategorized'));
    await loaded(uncategorizedFeedKey);
    expect(screen.queryByTestId(MORE)).toBeNull();
    held.release();
    await settle();
  });

  // The "Nothing to show yet" copy invites a pull; the pull spinner must actually show there, even
  // though the list is empty (the length>0 gate is widened by showUncategorizedMore). Fail-on-revert:
  // drop the `|| showUncategorizedMore` from the refreshing gate → the spinner stays down → RED.
  it('shows the pull spinner on the "Nothing to show yet" state (the instruction is honest)', async () => {
    server.seed(COUNT, { count: 3 });
    seedUncategorizedFeed(null);
    const { UNSAFE_getByType } = await renderTab();
    expect(screen.getByText('Nothing to show yet')).toBeTruthy();

    const held = server.hold(UNCATEGORIZED_FEED); // the list refresh stays pending mid-pull
    await act(async () => { UNSAFE_getByType(RefreshControl).props.onRefresh(); });
    expect(UNSAFE_getByType(RefreshControl).props.refreshing).toBe(true); // spinner shows despite the empty list

    await act(async () => { held.release(); });
    await waitFor(() => expect(UNSAFE_getByType(RefreshControl).props.refreshing).toBe(false));
  });
});
