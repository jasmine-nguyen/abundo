// WHIT-363 (adversarial edges) — Transactions pull-to-refresh spinner state machine.
// Companion to transactionsPullRefresh.screen.test.tsx (implementer's 8 happy/edge cases).
// This file adds ONLY the gaps: the pull-fetch-ERRORS path and the second-pull-after-resolve
// regression guard. Same mock harness as the sibling file.
//   [E1] a pull whose fetch ERRORS still clears the spinner (isFetching falls, isError true)
//   [E2] a second pull after the first resolves still spins and clears (flag machinery resets)
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, act } from '@testing-library/react-native';
import { RefreshControl } from 'react-native';

let mockTx: ReturnType<typeof txData>;
jest.mock('../queries', () => ({ useTransactionsScreenData: () => mockTx }));
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ openPicker: () => {} }) };
});
jest.mock('expo-router', () => {
  const React = require('react');
  return { useFocusEffect: (cb: () => void) => React.useEffect(() => cb(), [cb]), useRouter: () => ({ push: jest.fn() }) };
});

import Transactions from '../../app/(tabs)/transactions';

const refetch = jest.fn();
const refetchStale = jest.fn();

const CAT = { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7FD49B', recent: 0 };
const ROW = {
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'WOOLWORTHS', merchant_name: 'Woolworths', amount: -42, account_id: 'a1',
  account_name: 'ANZ', category: 'groceries', status: 'posted', type: 'purchase', counts_to_budget: true,
};
const category = (id: string | null) => (id === 'groceries' ? CAT : undefined);

function txData(over: Partial<{ transactions: unknown[]; isFetching: boolean; isError: boolean; isLoading: boolean }> = {}) {
  return { transactions: [], category, isLoading: false, isError: false, isFetching: false, refetch, refetchStale, ...over };
}

type GetByType = (t: typeof RefreshControl) => { props: any };
function pull(getByType: GetByType) { act(() => { getByType(RefreshControl).props.onRefresh(); }); }
const isSpinning = (getByType: GetByType) => getByType(RefreshControl).props.refreshing;

beforeEach(() => {
  refetch.mockClear();
  refetchStale.mockClear();
  mockTx = txData();
});

// [E1] The pull's fetch FAILS. isFetching still falls to false (the query settles into an
// error), so the falling-edge watcher must clear `pulling` — the spinner must not stick just
// because the fetch errored. isError is true but the list keeps its prior rows (no cold error
// screen), so RefreshControl is still mounted and would otherwise spin forever.
// Fail-on-revert: guard the clear with `&& !isError` in transactions.tsx (keep spinning on
// error) → pulling never clears → this assertion flips to true → RED.
it('[E1] a pull whose fetch ERRORS still clears the spinner', () => {
  mockTx = txData({ transactions: [ROW], isFetching: true });
  const { UNSAFE_getByType, rerender } = render(<Transactions />);
  pull(UNSAFE_getByType);
  expect(isSpinning(UNSAFE_getByType)).toBe(true);
  // Fetch settles into an error: isFetching false, isError true, rows unchanged.
  mockTx = { ...txData({ transactions: [ROW], isFetching: false }), isError: true };
  act(() => { rerender(<Transactions />); });
  expect(isSpinning(UNSAFE_getByType)).toBe(false); // cleared, not stuck on error
});

// [E3] A pull DURING the cold-load window (empty list still loading) must NOT double-spin with
// the inline loading spinner — the RefreshControl stays down and the centred inline spinner owns
// the empty first-load state. The `&& transactions.length > 0` guard on `refreshing` enforces it.
// Fail-on-revert: drop that guard (refreshing={pulling}) → a pull with an empty list raises the
// RefreshControl too → this assertion flips to true → RED.
it('[E3] a pull during a cold load does NOT raise the pull spinner (inline spinner owns it)', () => {
  mockTx = txData({ transactions: [], isLoading: true, isFetching: true });
  const { UNSAFE_getByType } = render(<Transactions />);
  pull(UNSAFE_getByType);
  expect(isSpinning(UNSAFE_getByType)).toBe(false); // empty list → pull spinner suppressed
});

// [E2] After one full pull cycle (spin → clear), a SECOND pull must spin again and clear —
// the `wasFetching` ref / `pulling` flag must reset, not latch permanently.
// Fail-on-revert: drop `setPulling(true)` from onRefresh → the second pull can't raise the
// spinner → the mid-test `true` assertion goes RED (same guard as sibling test 3, but this
// locks that it survives a prior completed cycle).
it('[E2] a second pull after the first resolves still spins and clears', () => {
  mockTx = txData({ transactions: [ROW], isFetching: true });
  const { UNSAFE_getByType, rerender } = render(<Transactions />);
  // First cycle.
  pull(UNSAFE_getByType);
  expect(isSpinning(UNSAFE_getByType)).toBe(true);
  mockTx = txData({ transactions: [ROW], isFetching: false });
  act(() => { rerender(<Transactions />); });
  expect(isSpinning(UNSAFE_getByType)).toBe(false);
  // Second cycle — a new fetch is in flight again.
  mockTx = txData({ transactions: [ROW], isFetching: true });
  act(() => { rerender(<Transactions />); });
  expect(isSpinning(UNSAFE_getByType)).toBe(false); // a background fetch alone: still no spinner
  pull(UNSAFE_getByType);
  expect(isSpinning(UNSAFE_getByType)).toBe(true);  // second pull raises it again
  mockTx = txData({ transactions: [ROW], isFetching: false });
  act(() => { rerender(<Transactions />); });
  expect(isSpinning(UNSAFE_getByType)).toBe(false); // and clears again
});
