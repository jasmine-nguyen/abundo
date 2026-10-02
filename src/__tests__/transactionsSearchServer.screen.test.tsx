// WHIT-576 — the Transactions search box searches ALL history on the server, not just the loaded
// feed pages. The bug: "steven" showed "No matches" while "Load More" was still on screen, because
// the match sat deeper in history than the 30 loaded rows. The screen and its data code are real,
// over the pretend server (WHIT-686): each test seeds the feed and the search answer, and checks
// the search requests the screen sends. Fake timers drive the typing pause.
import { it, expect, jest, beforeEach, afterEach, describe } from '@jest/globals';
import React from 'react';
import { screen, fireEvent, act, waitFor } from '@testing-library/react-native';

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ openPicker: jest.fn(), openMultiPicker: jest.fn(), showToast: jest.fn() }) };
});
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return { useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]), useRouter: () => ({ push: jest.fn() }) };
});

import Transactions from '../../app/(tabs)/transactions';
import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient, renderWithQueries } from './support/renderWithQueries';

const server = installFakeServer();
useTestQueryClient();

const FEED = '/transactions/feed';
const SEARCH = '/transactions/search';

const row = (id: string, merchant: string, amount: number, date = '2026-07-01') => ({
  transaction_id: id, date, authorized_date: date, description: merchant.toUpperCase(),
  merchant_name: merchant, amount, account_id: 'a1', account_name: 'ANZ', category: null,
  status: 'posted', type: 'PAYMENT', counts_to_budget: true,
});
const COLES = row('coles', 'Coles', -12.5);
const STEVEN_LOADED = row('steven-new', 'Steven Nguyen', -11);
const STEVEN_DEEP = row('steven-old', 'Steven Nguyen', -77, '2024-02-03');

const seedFeed = (transactions: unknown[], nextCursor: string | null = 'c1') => server.seed(FEED, { transactions, nextCursor });
const seedSearch = (transactions: unknown[], truncated = false) => server.seed(SEARCH, { transactions, truncated });
const searches = () => server.sentUnder('GET', SEARCH).map((request) => request.path);

const type = (query: string) => fireEvent.changeText(screen.getByPlaceholderText('Search transactions'), query);
const pauseTyping = () => act(async () => { jest.advanceTimersByTime(300); });

// Under fake timers the first reads can still be settling when renderWithQueries returns.
async function draw() {
  await renderWithQueries(<Transactions />);
  await waitFor(() => expect(screen.queryByTestId('transactions-loading')).toBeNull());
}

beforeEach(() => {
  jest.useFakeTimers();
  resetAuth();
  seedFeed([COLES, STEVEN_LOADED]);
});
afterEach(() => { jest.useRealTimers(); });

describe('asking the server', () => {
  it('asks once, after typing pauses — not on every keystroke', async () => {
    await draw();
    type('s');
    type('st');
    type('steven');
    await act(async () => { jest.advanceTimersByTime(299); });
    expect(searches()).toEqual([]);
    await pauseTyping();
    await waitFor(() => expect(searches()).toEqual(['/transactions/search?tab=all&q=steven']));
  });

  it('asks for the Uncategorized tab when searching there', async () => {
    await draw();
    fireEvent.press(screen.getByTestId('tab-uncategorized'));
    type('steven');
    await pauseTyping();
    await waitFor(() => expect(searches()).toEqual(['/transactions/search?tab=uncategorized&q=steven']));
  });

  it('a query of only $ or , never asks the server (it matches everything locally)', async () => {
    await draw();
    type('$,');
    await pauseTyping();
    await act(async () => { jest.advanceTimersByTime(1000); });
    expect(searches()).toEqual([]);
    expect(screen.getByText('-$12.50')).toBeTruthy();
    expect(screen.queryByTestId('transactions-searching')).toBeNull();
  });
});

describe('what the list shows', () => {
  it('shows a deep-history match the loaded pages never held (the "steven" bug)', async () => {
    seedFeed([COLES]);
    seedSearch([STEVEN_DEEP]);
    await draw();
    type('steven');
    await pauseTyping();
    expect(await screen.findByText('-$77.00')).toBeTruthy();
    expect(screen.queryByTestId('transactions-no-results')).toBeNull();
  });

  it('narrows instantly from the loaded rows before the server answers', async () => {
    await draw();
    type('steven');
    expect(screen.getByText('-$11.00')).toBeTruthy();
    expect(screen.queryByText('-$12.50')).toBeNull();
    expect(screen.getByTestId('transactions-searching')).toBeTruthy();
  });

  it('once answered, shows the server\'s matches (not the loaded rows)', async () => {
    seedSearch([STEVEN_DEEP]);
    await draw();
    type('steven');
    await pauseTyping();
    expect(await screen.findByText('-$77.00')).toBeTruthy();
    expect(screen.queryByText('-$11.00')).toBeNull();
    expect(screen.queryByTestId('transactions-searching')).toBeNull();
  });

  it('keeps filtering the answer by the live text while the next answer is on its way', async () => {
    seedFeed([], null);
    seedSearch([STEVEN_DEEP, row('stephanie', 'Stephanie', -5)]);
    await draw();
    type('ste');
    await pauseTyping();
    expect(await screen.findByText('-$5.00')).toBeTruthy();
    type('steven');
    expect(screen.queryByText('-$5.00')).toBeNull();
    expect(screen.getByText('-$77.00')).toBeTruthy();
  });

  it('never shows "No matches" while the server is still searching', async () => {
    seedFeed([COLES]);
    await draw();
    const held = server.hold(SEARCH);
    type('steven');
    await pauseTyping();
    await waitFor(() => expect(searches()).toHaveLength(1));
    expect(screen.queryByTestId('transactions-no-results')).toBeNull();
    expect(screen.getByTestId('transactions-searching')).toBeTruthy();

    held.release(); // the server answers: nothing matches
    expect(await screen.findByTestId('transactions-no-results')).toBeTruthy();
  });

  it('hides Load More during a search — the server already looked through all history', async () => {
    seedSearch([STEVEN_DEEP]);
    await draw();
    expect(screen.getByTestId('transactions-load-more')).toBeTruthy();
    type('steven');
    expect(screen.queryByTestId('transactions-load-more')).toBeNull();
  });

  it('says when the result cap cut off older matches', async () => {
    seedFeed([], null);
    seedSearch([STEVEN_DEEP], true);
    await draw();
    type('steven');
    await pauseTyping();
    expect(await screen.findByTestId('transactions-search-truncated')).toBeTruthy();
  });
});

describe('when the server search fails', () => {
  it('says so with a Retry — never "No matches", even when nothing loaded matches', async () => {
    seedFeed([COLES]);
    server.fail(SEARCH, 500);
    await draw();
    type('steven');
    await pauseTyping();
    expect(await screen.findByTestId('transactions-search-error')).toBeTruthy();
    expect(screen.queryByTestId('transactions-no-results')).toBeNull();
    fireEvent.press(screen.getByLabelText('Retry searching your full history'));
    await waitFor(() => expect(searches()).toEqual([
      '/transactions/search?tab=all&q=steven',
      '/transactions/search?tab=all&q=steven',
    ]));
  });

  it('keeps showing the loaded matches', async () => {
    server.fail(SEARCH, 500);
    await draw();
    type('steven');
    await pauseTyping();
    expect(await screen.findByTestId('transactions-search-error')).toBeTruthy();
    expect(screen.getByText('-$11.00')).toBeTruthy();
  });

  it('an earlier query\'s failure does not show while the next query waits to be sent', async () => {
    seedFeed([COLES]);
    server.fail(SEARCH, 500);
    await draw();
    type('stev');
    await pauseTyping();
    expect(await screen.findByTestId('transactions-search-error')).toBeTruthy();
    type('steven');
    expect(screen.queryByTestId('transactions-search-error')).toBeNull();
    expect(screen.getByTestId('transactions-searching')).toBeTruthy();
  });
});

it('limits the search box to the server\'s query length', async () => {
  await draw();
  expect(screen.getByPlaceholderText('Search transactions').props.maxLength).toBe(100);
});
