// WHIT-490 — the one Accounts-tab behaviour a FOURTH account newly requires: the accent palette
// must still hand out a distinct colour. accountsTab.screen.test.tsx already covers the
// card states (spinner/error/empty, red vs green balance, the "—" placeholder), and
// those hold at any account count, so they are not repeated here.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { Icon } from '../icons';

const bal = (over: Record<string, unknown> = {}) => ({
  account_id: 'a1', amount: 0, available_balance: 0, currency: 'AUD',
  as_of: '2026-09-05T03:58:13.856Z', account_type: 'unknown', ...over,
});

let mockTx: ReturnType<typeof txData>;
jest.mock('../queries', () => ({ useTransactionsScreenData: () => mockTx }));

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ showToast: jest.fn() }) };
});

jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return {
    useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]),
    useRouter: () => ({ push: jest.fn() }),
  };
});

import Accounts from '../../app/(tabs)/accounts';

const ROW = {
  transaction_id: 't1', date: '2026-09-02', authorized_date: '2026-09-02',
  description: 'WOOLWORTHS', merchant_name: 'Woolworths', amount: -42, account_id: 'a1',
  account_name: 'ANZ', category: 'groceries', status: 'posted', type: 'purchase', counts_to_budget: true,
};
const row = (over: Record<string, unknown>) => ({ ...ROW, ...over });

const FOUR_ACCOUNTS = [
  row({ transaction_id: 's1', account_id: 'up-spending', account_name: 'Up Spending' }),
  row({ transaction_id: 'a1', account_id: 'anz-rewards-black-visa', account_name: 'ANZ Rewards Black Visa' }),
  row({ transaction_id: 'h1', account_id: 'up-homeloan', account_name: 'Up Homeloan' }),
  row({
    transaction_id: 'bank_tx_b220e370', account_id: 'westpac-altitude-qantas-black',
    account_name: 'Altitude Qantas Black Card', merchant_name: 'UNIFLEXREMEDIALMASSAGE',
    description: 'UNIFLEXREMEDIALMASSAGE ALTONA NORT AUS', amount: -155, category: 'health',
  }),
];

const FOUR_BALANCES = new Map<string, unknown>([
  ['up-spending', bal({ account_id: 'up-spending', amount: 96270.59 })],
  ['anz-rewards-black-visa', bal({ account_id: 'anz-rewards-black-visa', amount: -6492.26 })],
  ['up-homeloan', bal({ account_id: 'up-homeloan', amount: -596642.43 })],
  ['westpac-altitude-qantas-black', bal({
    account_id: 'westpac-altitude-qantas-black', amount: -230, available_balance: 5770,
  })],
]);

function txData(over: Partial<{
  transactions: unknown[]; isLoading: boolean; isError: boolean; balances: Map<string, unknown>;
}> = {}) {
  return {
    transactions: [] as unknown[], category: () => undefined,
    balances: new Map<string, unknown>(), isLoading: false, isError: false,
    refetch: jest.fn(), refetchStale: jest.fn(),
    refetchList: jest.fn(() => Promise.resolve()),
    refreshLiveBalances: jest.fn(() => Promise.resolve()),
    ...over,
  };
}

beforeEach(() => {
  mockTx = txData();
});

it('gives the fourth account its own accent colour instead of reusing the first', () => {
  // The chip colour is ACCOUNT_ACCENTS[i % length]. A fourth account is the first to
  // require the palette to hold at least four entries — shrink it to three and card 4
  // wears card 1's colour, so the two read as the same account at a glance. Nothing
  // else guards that, and only a fourth account makes it reachable.
  mockTx = txData({ transactions: FOUR_ACCOUNTS, balances: FOUR_BALANCES });
  render(<Accounts />);

  // Filtered by name: the account chip is the only "bank" Icon today, but any future
  // chrome icon would otherwise break this with a baffling message.
  const chips = screen.UNSAFE_getAllByType(Icon).filter((i) => (i.props as { name: string }).name === 'bank');
  expect(chips).toHaveLength(4);
  expect(new Set(chips.map((i) => (i.props as { color: string }).color)).size).toBe(4);
});
