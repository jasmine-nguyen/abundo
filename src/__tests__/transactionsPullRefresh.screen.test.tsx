// Screen test (WHIT-74 regression guard): the Transactions pull-to-refresh must be
// wired to `retryLoad`, NOT `refreshTransactions`. This is the exact round-1 bug —
// a successful pull did NOT clear the "couldn't load" banner because it only
// re-fetched transactions. Nothing else in the suite renders the Transactions screen
// and asserts the RefreshControl wiring, so a revert to onRefresh={s.refreshTransactions}
// would otherwise pass green. Fail-on-revert: pulls apart onRefresh identity + call.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render } from '@testing-library/react-native';
import { RefreshControl } from 'react-native';
import { makeState } from './factory';
import type { AppContext } from '../context';

// Inject a controlled context but keep the real transactionGroups/countUncategorized
// selectors (same module), matching the TransactionRow.screen.test pattern.
let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});

import Transactions from '../../app/(tabs)/transactions';

const retryLoad = jest.fn();
const refreshTransactions = jest.fn();

function stateWith(over: Partial<AppContext> = {}): AppContext {
  return { ...makeState(), transactionsLoading: false, retryLoad, refreshTransactions, ...over } as AppContext;
}

beforeEach(() => {
  retryLoad.mockClear();
  refreshTransactions.mockClear();
});

it('pull-to-refresh onRefresh is retryLoad (the full reload), not refreshTransactions', () => {
  mockState = stateWith();
  const { UNSAFE_getByType } = render(<Transactions />);
  const rc = UNSAFE_getByType(RefreshControl);
  // Identity guard: reverting to s.refreshTransactions flips both of these.
  expect(rc.props.onRefresh).toBe(retryLoad);
  expect(rc.props.onRefresh).not.toBe(refreshTransactions);
});

it('firing the RefreshControl calls retryLoad once and never refreshTransactions', () => {
  mockState = stateWith();
  const { UNSAFE_getByType } = render(<Transactions />);
  UNSAFE_getByType(RefreshControl).props.onRefresh();
  expect(retryLoad).toHaveBeenCalledTimes(1);
  expect(refreshTransactions).not.toHaveBeenCalled();
});

it('the spinner is bound to transactionsLoading', () => {
  mockState = stateWith({ transactionsLoading: true } as Partial<AppContext>);
  const { UNSAFE_getByType } = render(<Transactions />);
  expect(UNSAFE_getByType(RefreshControl).props.refreshing).toBe(true);
});
