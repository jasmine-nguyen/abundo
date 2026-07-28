// Screen test (WHIT-74 → WHIT-190a → WHIT-192 → WHIT-363): the Transactions list is query-fed,
// and pull-to-refresh refetches the VISIBLE LIST ONLY (the query). WHIT-192 dropped the old
// `retryLoad` app-wide reload from the pull — the other screens' reads each refresh on their own
// focus.
//
// WHIT-363: the pull spinner is now driven by a local `pulling` flag set ONLY on a user pull, not
// by the query's raw `isFetching`. The on-focus background refetch (refetchStale) also flips
// isFetching, and binding the spinner to isFetching let that programmatic refresh raise a spinner
// RN's RefreshControl then failed to dismiss — it stuck below the title on return from a
// transaction detail page. So the tests below assert: a background refetch (isFetching true, NO
// pull) leaves the spinner DOWN; a real pull raises it; it clears when that pull's fetch ends.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, act } from '@testing-library/react-native';
import { RefreshControl } from 'react-native';

// The list is query-fed — mock the composite. WHIT-192: transactions.tsx no longer reads the
// store, but the TransactionRow children it renders still pull openPicker off it, so stub that.
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
import { HEADER_BODY_HEIGHT } from '../motion/useNavBarsHeader';

const refetch = jest.fn();
const refetchStale = jest.fn();

const CAT = { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7FD49B', recent: 0 };
const ROW = {
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'WOOLWORTHS', merchant_name: 'Woolworths', amount: -42, account_id: 'a1',
  account_name: 'ANZ', category: 'groceries', status: 'posted', type: 'purchase', counts_to_budget: true,
};
const category = (id: string | null) => (id === 'groceries' ? CAT : undefined);

function txData(over: Partial<{ transactions: unknown[]; isFetching: boolean }> = {}) {
  return { transactions: [], category, isLoading: false, isError: false, isFetching: false, refetch, refetchStale, ...over };
}

// `props` is `any` to match testing-library's UNSAFE_getByType return (ReactTestInstance).
type GetByType = (t: typeof RefreshControl) => { props: any };

// Fire the RefreshControl's onRefresh the way a user pull does, flushing the state update.
function pull(getByType: GetByType) {
  act(() => { getByType(RefreshControl).props.onRefresh(); });
}
const isSpinning = (getByType: GetByType) => getByType(RefreshControl).props.refreshing;

beforeEach(() => {
  refetch.mockClear();
  refetchStale.mockClear();
  mockTx = txData();
});

it('pull-to-refresh refetches the visible list (the query), and nothing else', () => {
  const { UNSAFE_getByType } = render(<Transactions />);
  pull(UNSAFE_getByType);
  expect(refetch).toHaveBeenCalledTimes(1); // WHIT-192: refreshes the query-backed list only
});

// WHIT-363 fail-on-revert: this is the bug. A background/focus refetch (refetchStale) flips
// isFetching true with NO user pull. The list is non-empty, so the reverted
// `refreshing={isFetching && transactions.length > 0}` would be TRUE here — a stuck spinner.
// The fix (`refreshing={pulling}`) keeps it DOWN because the user never pulled.
it('a background/focus refetch (isFetching, non-empty list, NO pull) does NOT raise the spinner', () => {
  mockTx = txData({ transactions: [ROW], isFetching: true });
  const { UNSAFE_getByType } = render(<Transactions />);
  expect(isSpinning(UNSAFE_getByType)).toBe(false);
});

it('a genuine user pull raises the spinner while its fetch runs', () => {
  mockTx = txData({ transactions: [ROW], isFetching: true });
  const { UNSAFE_getByType } = render(<Transactions />);
  pull(UNSAFE_getByType);
  expect(isSpinning(UNSAFE_getByType)).toBe(true);
});

it('the pull spinner clears when that pull\'s fetch resolves', () => {
  // Pull while a fetch is in flight (isFetching true) so the falling-edge watcher latches it...
  mockTx = txData({ transactions: [ROW], isFetching: true });
  const { UNSAFE_getByType, rerender } = render(<Transactions />);
  pull(UNSAFE_getByType);
  expect(isSpinning(UNSAFE_getByType)).toBe(true);
  // ...then the fetch settles (isFetching false) → the watcher clears `pulling`.
  mockTx = txData({ transactions: [ROW], isFetching: false });
  act(() => { rerender(<Transactions />); });
  expect(isSpinning(UNSAFE_getByType)).toBe(false);
});

// The exact scenario the card is about: returning from a detail page fires refetchStale (a
// background fetch, isFetching already true) and the user pulls DURING it. The pull must still
// spin, and must clear when the fetch ends — not stick.
it('a pull DURING an in-flight background refetch spins, then clears when it ends', () => {
  mockTx = txData({ transactions: [ROW], isFetching: true }); // background refetch already running
  const { UNSAFE_getByType, rerender } = render(<Transactions />);
  expect(isSpinning(UNSAFE_getByType)).toBe(false); // background alone: no spinner
  pull(UNSAFE_getByType);
  expect(isSpinning(UNSAFE_getByType)).toBe(true); // user pulled during it
  mockTx = txData({ transactions: [ROW], isFetching: false });
  act(() => { rerender(<Transactions />); });
  expect(isSpinning(UNSAFE_getByType)).toBe(false); // clears, not stuck
});

it('the pull spinner does NOT spin during a cold load (empty + fetching) — the inline spinner owns it', () => {
  mockTx = txData({ transactions: [], isFetching: true });
  const { UNSAFE_getByType } = render(<Transactions />);
  expect(isSpinning(UNSAFE_getByType)).toBe(false);
});

it('the spinner is down when nothing is fetching', () => {
  mockTx = txData({ transactions: [ROW], isFetching: false });
  const { UNSAFE_getByType } = render(<Transactions />);
  expect(isSpinning(UNSAFE_getByType)).toBe(false);
});

// WHIT-211: the floating header (position:absolute, opaque, zIndex 10 since WHIT-184) sits over
// the top of the list, so the pull spinner — drawn at y≈0 — was painted behind it and invisible.
// progressViewOffset pushes the spinner down past the header. In tests insets.top is 0, so the
// header height is exactly HEADER_BODY_HEIGHT. Fail-on-revert: drop progressViewOffset and the
// prop is undefined, not the header height.
it('offsets the pull spinner below the floating header so it is not hidden behind it', () => {
  mockTx = txData({ transactions: [ROW], isFetching: true });
  const { UNSAFE_getByType } = render(<Transactions />);
  const offset = UNSAFE_getByType(RefreshControl).props.progressViewOffset;
  expect(offset).toBe(HEADER_BODY_HEIGHT); // insets.top (0 in tests) + HEADER_BODY_HEIGHT
  expect(offset).toBeGreaterThan(0);       // must clear the header, never draw behind it at y≈0
});
