// WHIT-576 — the Transactions search box searches ALL history on the server, not just the loaded
// feed pages. The bug: "steven" showed "No matches" while "Load More" was still on screen, because
// the match sat deeper in history than the 30 loaded rows. The data hook is mocked and records the
// query the screen asks the server for, so each state is driven deterministically.
import { it, expect, jest, beforeEach, afterEach, describe } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';

let mockTx: ReturnType<typeof transactionsScreenData>;
const mockHookCalls: [string, string][] = [];
jest.mock('../queries', () => ({
  useTransactionsScreenData: (tab: string, serverQuery: string) => {
    mockHookCalls.push([tab, serverQuery]);
    return mockTx;
  },
  useUncategorizedCount: () => undefined,
  useUncategorizedMerchants: () => ({ merchants: undefined, isLoading: false, isError: false }),
}));
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ openPicker: jest.fn(), openMultiPicker: jest.fn(), showToast: jest.fn() }) };
});
jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return { useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]), useRouter: () => ({ push: jest.fn() }) };
});

import Transactions from '../../app/(tabs)/transactions';
import { transactionsScreenData, idleSearch } from './support/transactionsScreenData';

const row = (id: string, merchant: string, amount: number, date = '2026-07-01') => ({
  transaction_id: id, date, authorized_date: date, description: merchant.toUpperCase(),
  merchant_name: merchant, amount, account_id: 'a1', account_name: 'ANZ', category: null,
  status: 'posted', type: 'PAYMENT', counts_to_budget: true,
});
const COLES = row('coles', 'Coles', -12.5);
const STEVEN_LOADED = row('steven-new', 'Steven Nguyen', -11);
const STEVEN_DEEP = row('steven-old', 'Steven Nguyen', -77, '2024-02-03');

const type = (query: string) => fireEvent.changeText(screen.getByPlaceholderText('Search transactions'), query);
const pauseTyping = () => act(() => { jest.advanceTimersByTime(300); });
const answered = (results: unknown[], over: Record<string, unknown> = {}) =>
  ({ ...idleSearch, active: true, answered: true, results, ...over });

beforeEach(() => {
  jest.useFakeTimers();
  mockHookCalls.length = 0;
  mockTx = transactionsScreenData({ transactions: [COLES, STEVEN_LOADED], hasMore: true });
});
afterEach(() => { jest.useRealTimers(); });

describe('asking the server', () => {
  it('asks once, after typing pauses — not on every keystroke', () => {
    render(<Transactions />);
    type('s');
    type('st');
    type('steven');
    expect(mockHookCalls.at(-1)).toEqual(['all', '']);
    pauseTyping();
    expect(mockHookCalls.at(-1)).toEqual(['all', 'steven']);
    expect(mockHookCalls.filter(([, query]) => query !== '').map(([, query]) => query)).toEqual(['steven']);
  });

  it('asks for the Uncategorized tab when searching there', () => {
    render(<Transactions />);
    fireEvent.press(screen.getByTestId('tab-uncategorized'));
    type('steven');
    pauseTyping();
    expect(mockHookCalls.at(-1)).toEqual(['uncategorized', 'steven']);
  });

  it('a query of only $ or , never asks the server (it matches everything locally)', () => {
    render(<Transactions />);
    type('$,');
    pauseTyping();
    expect(mockHookCalls.at(-1)).toEqual(['all', '']);
    expect(screen.getByText('-$12.50')).toBeTruthy();
    expect(screen.queryByTestId('transactions-searching')).toBeNull();
  });
});

describe('what the list shows', () => {
  it('shows a deep-history match the loaded pages never held (the "steven" bug)', () => {
    mockTx = transactionsScreenData({ transactions: [COLES], hasMore: true, search: answered([STEVEN_DEEP]) });
    render(<Transactions />);
    type('steven');
    pauseTyping();
    expect(screen.getByText('-$77.00')).toBeTruthy();
    expect(screen.queryByTestId('transactions-no-results')).toBeNull();
  });

  it('narrows instantly from the loaded rows before the server answers', () => {
    render(<Transactions />);
    type('steven');
    expect(screen.getByText('-$11.00')).toBeTruthy();
    expect(screen.queryByText('-$12.50')).toBeNull();
    expect(screen.getByTestId('transactions-searching')).toBeTruthy();
  });

  it('once answered, shows the server\'s matches (not the loaded rows)', () => {
    mockTx = transactionsScreenData({ transactions: [COLES, STEVEN_LOADED], search: answered([STEVEN_DEEP]) });
    render(<Transactions />);
    type('steven');
    pauseTyping();
    expect(screen.getByText('-$77.00')).toBeTruthy();
    expect(screen.queryByText('-$11.00')).toBeNull();
    expect(screen.queryByTestId('transactions-searching')).toBeNull();
  });

  it('keeps filtering the answer by the live text while the next answer is on its way', () => {
    mockTx = transactionsScreenData({ transactions: [], search: answered([STEVEN_DEEP, row('stephanie', 'Stephanie', -5)]) });
    render(<Transactions />);
    type('ste');
    pauseTyping();
    expect(screen.getByText('-$5.00')).toBeTruthy();
    type('steven');
    expect(screen.queryByText('-$5.00')).toBeNull();
    expect(screen.getByText('-$77.00')).toBeTruthy();
  });

  it('never shows "No matches" while the server is still searching', () => {
    mockTx = transactionsScreenData({ transactions: [COLES], hasMore: true, search: { ...idleSearch, active: true } });
    render(<Transactions />);
    type('steven');
    pauseTyping();
    expect(screen.queryByTestId('transactions-no-results')).toBeNull();
    expect(screen.getByTestId('transactions-searching')).toBeTruthy();
  });

  it('hides Load More during a search — the server already looked through all history', () => {
    mockTx = transactionsScreenData({ transactions: [COLES, STEVEN_LOADED], hasMore: true, search: answered([STEVEN_DEEP]) });
    render(<Transactions />);
    expect(screen.getByTestId('transactions-load-more')).toBeTruthy();
    type('steven');
    expect(screen.queryByTestId('transactions-load-more')).toBeNull();
  });

  it('says when the result cap cut off older matches', () => {
    mockTx = transactionsScreenData({ search: answered([STEVEN_DEEP], { truncated: true }) });
    render(<Transactions />);
    type('steven');
    pauseTyping();
    expect(screen.getByTestId('transactions-search-truncated')).toBeTruthy();
  });
});

describe('when the server search fails', () => {
  it('says so with a Retry — never "No matches", even when nothing loaded matches', () => {
    const retry = jest.fn();
    mockTx = transactionsScreenData({ transactions: [COLES], search: { ...idleSearch, active: true, isError: true, retry } });
    render(<Transactions />);
    type('steven');
    pauseTyping();
    expect(screen.getByTestId('transactions-search-error')).toBeTruthy();
    expect(screen.queryByTestId('transactions-no-results')).toBeNull();
    fireEvent.press(screen.getByLabelText('Retry searching your full history'));
    expect(retry).toHaveBeenCalled();
  });

  it('keeps showing the loaded matches', () => {
    mockTx = transactionsScreenData({ transactions: [COLES, STEVEN_LOADED], search: { ...idleSearch, active: true, isError: true } });
    render(<Transactions />);
    type('steven');
    pauseTyping();
    expect(screen.getByText('-$11.00')).toBeTruthy();
  });

  it('an earlier query\'s failure does not show while the next query waits to be sent', () => {
    mockTx = transactionsScreenData({ transactions: [COLES], search: { ...idleSearch, active: true, isError: true } });
    render(<Transactions />);
    type('stev');
    pauseTyping();
    expect(screen.getByTestId('transactions-search-error')).toBeTruthy();
    type('steven');
    expect(screen.queryByTestId('transactions-search-error')).toBeNull();
    expect(screen.getByTestId('transactions-searching')).toBeTruthy();
  });
});

it('limits the search box to the server\'s query length', () => {
  render(<Transactions />);
  expect(screen.getByPlaceholderText('Search transactions').props.maxLength).toBe(100);
});
