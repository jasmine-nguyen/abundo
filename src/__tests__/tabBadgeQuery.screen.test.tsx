// WHIT-203 GAP — the uncategorized tab dot is now driven by the tab bar's OWN
// useTransactionsScreenData() query (it used to come from the eager store app-wide). Locks:
// an uncategorized, budget-counting txn from the query → dot; none → no dot. Reverting the
// tab bar off the query (or breaking countUncategorized's input) fails these.
import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { txn } from './factory';

const uncategorized = (_id: string | null) => undefined; // rows resolve to no category → uncategorized
let mockTx: { transactions: unknown[]; category: (id: string | null) => unknown };
jest.mock('../queries', () => ({ useTransactionsScreenData: () => mockTx }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('../motion/NavBarsContext', () => ({ useNavBars: () => ({ visibility: { interpolate: () => 0 } }) }));
// expo-router's Tabs pulls in native modules that can't load headlessly; the TabBar under
// test doesn't use them, so stub the module.
jest.mock('expo-router', () => ({ Tabs: Object.assign(() => null, { Screen: () => null }) }));

import { TabBar } from '../../app/(tabs)/_layout';

const barProps: React.ComponentProps<typeof TabBar> = {
  state: { index: 0, routes: [{ key: 'transactions', name: 'transactions' }] },
  navigation: { emit: () => ({ defaultPrevented: false }), navigate: jest.fn() },
};

it('renders the dot when the query has an uncategorized, budget-counting txn', () => {
  mockTx = { transactions: [txn({ category: null, counts_to_budget: true })], category: uncategorized };
  render(<TabBar {...barProps} />);
  expect(screen.getByTestId('tab-uncat-dot')).toBeTruthy();
});

it('renders no dot when the query has none uncategorized', () => {
  mockTx = { transactions: [txn({ category: 'coffee', counts_to_budget: true })], category: (id: string | null) => (id ? { id } : undefined) };
  render(<TabBar {...barProps} />);
  expect(screen.queryByTestId('tab-uncat-dot')).toBeNull();
});
