// WHIT-190a — Transactions screen STATE GATING (gaps): the showSpinner/showError
// length===0 guards (cache-first: keep rows through a background refetch / an error)
// and the empty states. The composite (../queries) is mocked so each gating branch is
// driven deterministically; ../context is partially mocked (real selectors, stubbed
// useAppContext for TransactionRow).
// WHIT-215 — the Accounts tab now DERIVES from the transactions query (one card per
// account_id), so the cold-load spinner + error apply to it too, and an account name
// rendered from the fixture proves the derivation. Fail-on-revert: dropping
// `transactions.length === 0` from showError makes the "error with cached rows" case
// surface the error.
import { it, expect, jest, beforeEach, describe } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import { StyleSheet, RefreshControl } from 'react-native';
import { C } from '../theme';
import { HEADER_BODY_HEIGHT } from '../motion/useNavBarsHeader';

const bal = (over: Record<string, unknown> = {}) => ({
  account_id: 'a1', amount: 96270.59, available_balance: 96270.59, currency: 'AUD',
  as_of: '2026-07-08T09:32:02.405Z', account_type: 'checking', ...over,
});
const colorOf = (node: unknown) => (StyleSheet.flatten((node as { props: { style?: unknown } }).props.style) as { color?: string }).color;

// WHIT-459: the folded siblings each carry their own block-scoped `txData` (some omit `balances`);
// they all assign to this shared `mockTx`, so `balances` is optional here to accept every shape.
let mockTx: Omit<ReturnType<typeof txData>, 'balances'> & { balances?: Map<string, unknown> };
jest.mock('../queries', () => ({ useTransactionsScreenData: () => mockTx }));

const CAT = { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7FD49B', recent: 0 };
// WHIT-459: superset useAppContext stub covering every folded sibling. The component reads only
// `openMultiPicker` off context (line 24 of transactions.tsx) and TransactionRow reads `openPicker`;
// `retryLoad` and `category` are inert here (the component uses the query's `category`). SelectMode
// asserts on `mockOpenMultiPicker`, so it points at a shared module-scope mock.
const mockOpenMultiPicker = jest.fn();
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return {
    ...actual,
    useAppContext: () => ({
      retryLoad: jest.fn(),
      openPicker: jest.fn(),
      openMultiPicker: mockOpenMultiPicker,
      category: (id: string | null) => (id === 'groceries' ? CAT : undefined),
    }),
  };
});

const mockPush = jest.fn();
jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return {
    useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]),
    useRouter: () => ({ push: mockPush }),
  };
});

import Transactions from '../../app/(tabs)/transactions';

const refetch = jest.fn();
const refetchStale = jest.fn();

const ROW = {
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'WOOLWORTHS', merchant_name: 'Woolworths', amount: -42, account_id: 'a1',
  account_name: 'ANZ', category: 'groceries', status: 'posted', type: 'purchase', counts_to_budget: true,
};

function txData(over: Partial<{
  transactions: unknown[]; isLoading: boolean; isError: boolean; isFetching: boolean;
  balances: Map<string, unknown>;
}> = {}) {
  return {
    transactions: [], category: (id: string | null) => (id === 'groceries' ? CAT : undefined),
    balances: new Map(), isLoading: false, isError: false, isFetching: false, refetch, refetchStale, ...over,
  };
}

beforeEach(() => {
  refetch.mockClear();
  refetchStale.mockClear();
  mockPush.mockClear();
  mockTx = txData();
});

it('error WITH cached rows keeps the rows and shows NO inline error (cache-first)', () => {
  mockTx = txData({ transactions: [ROW], isError: true });
  render(<Transactions />);
  expect(screen.getByText('-$42.00')).toBeTruthy();
  expect(screen.queryByTestId('transactions-error')).toBeNull();
});

it('a background refetch (isLoading) with cached rows does NOT blank the list', () => {
  mockTx = txData({ transactions: [ROW], isLoading: true });
  render(<Transactions />);
  expect(screen.getByText('-$42.00')).toBeTruthy();
  expect(screen.queryByTestId('transactions-loading')).toBeNull();
});

it('empty + error shows the inline retry, and Retry calls refetch', () => {
  mockTx = txData({ transactions: [], isError: true });
  render(<Transactions />);
  expect(screen.getByTestId('transactions-error')).toBeTruthy();
  fireEvent.press(screen.getByTestId('transactions-retry'));
  expect(refetch).toHaveBeenCalledTimes(1);
});

it('empty + loading shows the spinner', () => {
  mockTx = txData({ transactions: [], isLoading: true });
  render(<Transactions />);
  expect(screen.getByTestId('transactions-loading')).toBeTruthy();
});

it('Accounts tab derives one card per account_id from the transactions (consistent name)', () => {
  const anz = { ...ROW, transaction_id: 't1', account_id: 'a1', account_name: 'ANZ' };
  const up = { ...ROW, transaction_id: 't2', account_id: 'a2', account_name: 'Up Homeloan' };
  const up2 = { ...ROW, transaction_id: 't3', account_id: 'a2', account_name: 'Up Homeloan' };
  mockTx = txData({ transactions: [anz, up, up2] });
  render(<Transactions />);
  fireEvent.press(screen.getByText('Accounts'));
  // One card per account; the Up account (2 txns) collapses to a single consistent name.
  expect(screen.getByText('ANZ')).toBeTruthy();
  expect(screen.getAllByText('Up Homeloan')).toHaveLength(1);
});

it('tapping an account card navigates to that account\'s detail route', () => {
  mockTx = txData({ transactions: [{ ...ROW, account_id: 'a1', account_name: 'ANZ' }] });
  render(<Transactions />);
  fireEvent.press(screen.getByText('Accounts'));
  fireEvent.press(screen.getByText('ANZ'));
  expect(mockPush).toHaveBeenCalledWith('/account/a1');
});

it('Accounts tab shows the cold-load spinner (empty + loading) — it derives from the query now', () => {
  mockTx = txData({ transactions: [], isLoading: true, isError: false });
  render(<Transactions />);
  fireEvent.press(screen.getByText('Accounts'));
  expect(screen.getByTestId('transactions-loading')).toBeTruthy();
});

it('Accounts tab shows the inline retry on a cold error (empty + error)', () => {
  mockTx = txData({ transactions: [], isError: true });
  render(<Transactions />);
  fireEvent.press(screen.getByText('Accounts'));
  expect(screen.getByTestId('transactions-error')).toBeTruthy();
});

it('Accounts tab keeps its cards through a background error when txns are cached (cache-first)', () => {
  mockTx = txData({ transactions: [{ ...ROW, account_id: 'a1', account_name: 'ANZ' }], isError: true });
  render(<Transactions />);
  fireEvent.press(screen.getByText('Accounts'));
  expect(screen.getByText('ANZ')).toBeTruthy();
  expect(screen.queryByTestId('transactions-error')).toBeNull();
});

it('Accounts tab settled with no transactions shows the empty state', () => {
  mockTx = txData({ transactions: [] });
  render(<Transactions />);
  fireEvent.press(screen.getByText('Accounts'));
  expect(screen.getByText('No accounts yet')).toBeTruthy();
});

it('an account card shows its live balance — green when in credit (amount >= 0)', () => {
  mockTx = txData({
    transactions: [{ ...ROW, account_id: 'a1', account_name: 'Up Spending' }],
    balances: new Map([['a1', bal({ amount: 96270.59 })]]),
  });
  render(<Transactions />);
  fireEvent.press(screen.getByText('Accounts'));
  const label = screen.getByText('$96,270.59'); // bare, no + sign
  expect(colorOf(label)).toBe(C.good);
});

it('an account card shows a negative balance in red (money owed)', () => {
  mockTx = txData({
    transactions: [{ ...ROW, account_id: 'a1', account_name: 'Up Homeloan' }],
    balances: new Map([['a1', bal({ amount: -596642.43 })]]),
  });
  render(<Transactions />);
  fireEvent.press(screen.getByText('Accounts'));
  const label = screen.getByText('-$596,642.43');
  expect(colorOf(label)).toBe(C.bad);
});

it('an account with no balance yet shows a dim "—" placeholder', () => {
  mockTx = txData({
    transactions: [{ ...ROW, account_id: 'a1', account_name: 'ANZ' }],
    balances: new Map(), // not polled yet
  });
  render(<Transactions />);
  fireEvent.press(screen.getByText('Accounts'));
  expect(screen.getByText('—')).toBeTruthy();
});

it('empty Uncategorized tab (settled) shows the "All caught up" empty state', () => {
  mockTx = txData({ transactions: [] });
  render(<Transactions />);
  fireEvent.press(screen.getByText('Uncategorized'));
  expect(screen.getByText('All caught up')).toBeTruthy();
});

it('empty All tab (settled) shows nothing: no empty state, no rows, no spinner, no error', () => {
  mockTx = txData({ transactions: [] });
  render(<Transactions />);
  expect(screen.queryByText('All caught up')).toBeNull(); // "all" has no empty state by design
  expect(screen.queryByText('-$42.00')).toBeNull();
  expect(screen.queryByTestId('transactions-loading')).toBeNull();
  expect(screen.queryByTestId('transactions-error')).toBeNull();
});

// ===== Load More (folded from transactionsLoadMore.screen.test.tsx) =====
// The Transactions tab "Load More" control. The feed's paging fields (hasMore / loadMore /
// isLoadingMore) come from useTransactionsScreenData; this locks the button's render states +
// tap wiring. The composite/query behaviour (append, cursor, snap-to-newest) is covered in
// transactionsFeed.screen. Reuses the module-scope `../queries`/`../context`/expo-router mocks.
describe('Transactions — Load More', () => {
const mockLoadMore = jest.fn();
// `CAT` reused from module scope (byte-identical). `row`/`category`/`txData` are sibling-only.
const row = (id: string) => ({
  transaction_id: id, date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'WOOLWORTHS', merchant_name: 'Woolworths', amount: -42, account_id: 'a1',
  account_name: 'ANZ', category: 'groceries', status: 'posted', type: 'purchase', counts_to_budget: true,
});
const category = (id: string | null) => (id === 'groceries' ? CAT : undefined);

function txData(over: Partial<{ transactions: unknown[]; hasMore: boolean; isLoadingMore: boolean }> = {}) {
  return {
    transactions: [row('t1')], category, balances: new Map(),
    isLoading: false, isError: false, isFetching: false, refetch: jest.fn(), refetchStale: jest.fn(),
    hasMore: false, loadMore: mockLoadMore, isLoadingMore: false, ...over,
  };
}

beforeEach(() => {
  mockLoadMore.mockClear();
  mockTx = txData();
});

it('shows Load More when there is more history, and tapping it pages older rows in', () => {
  mockTx = txData({ hasMore: true });
  render(<Transactions />);
  fireEvent.press(screen.getByTestId('transactions-load-more'));
  expect(mockLoadMore).toHaveBeenCalledTimes(1);
});

it('hides Load More at end-of-history (hasMore false)', () => {
  mockTx = txData({ hasMore: false });
  render(<Transactions />);
  expect(screen.queryByTestId('transactions-load-more')).toBeNull();
});

it('swaps the button for a spinner while the next page is loading', () => {
  mockTx = txData({ hasMore: true, isLoadingMore: true });
  render(<Transactions />);
  expect(screen.queryByTestId('transactions-load-more')).toBeNull(); // button hidden while loading
  expect(screen.getByTestId('transactions-load-more-spinner')).toBeTruthy();
});

it('does not show Load More on the Accounts tab', () => {
  mockTx = txData({ hasMore: true });
  render(<Transactions />);
  fireEvent.press(screen.getByText('Accounts'));
  expect(screen.queryByTestId('transactions-load-more')).toBeNull();
});
});

// ===== WHIT-363 pull-to-refresh (folded from transactionsPullRefresh.screen.test.tsx) =====
// The Transactions list is query-fed, and pull-to-refresh refetches the VISIBLE LIST ONLY (the
// query). WHIT-363: the pull spinner is driven by a local `pulling` flag set ONLY on a user pull,
// not by the query's raw `isFetching`. Reuses the module-scope mocks; `refetch`/`refetchStale`/
// `CAT`/`ROW` reused from module scope (byte-identical).
describe('Transactions — pull-to-refresh (WHIT-363)', () => {
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

// Fail-on-revert, and the complement of the background test above: with NO fetch in flight, a
// finger-pull STILL raises the spinner — proving `pulling` alone drives it, not `isFetching`.
// Revert to `refreshing={isFetching && transactions.length > 0}` and this goes RED (isFetching is
// false here, so the reverted expression is false).
it('a genuine user pull raises the spinner even with no background fetch (pulling drives it)', () => {
  mockTx = txData({ transactions: [ROW], isFetching: false });
  const { UNSAFE_getByType } = render(<Transactions />);
  pull(UNSAFE_getByType);
  expect(isSpinning(UNSAFE_getByType)).toBe(true);
});

// Also covers the card's exact scenario: a background refetch (refetchStale) is already in flight
// (isFetching true) when the user pulls DURING it — the pull spins, then clears when the fetch
// ends, not sticks.
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
});

// ===== WHIT-363 adversarial edges (folded from transactionsPullRefreshEdges.screen.test.tsx) =====
// Companion to the pull-to-refresh block above: the pull-fetch-ERRORS path, the cold-load
// suppression, and the second-pull-after-resolve regression guard. Reuses module-scope mocks;
// `refetch`/`refetchStale`/`CAT`/`ROW` reused from module scope (byte-identical).
describe('Transactions — pull-to-refresh adversarial edges (WHIT-363)', () => {
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
});

// ===== Search (folded from transactionsSearch.screen.test.tsx) =====
// The Transactions-tab search box: typing filters the list live, the ✕ clears it, no matches
// shows an empty state, and entering selection mode clears the search. This block seeds its own
// two-category fixture (Groceries + Cafes & Coffee) via the query's `category`. Reuses the
// module-scope mocks.
describe('Transactions — search', () => {
const CATS: Record<string, { id: string; name: string; bucket: string; icon: string; color: string; recent: number }> = {
  groceries: { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7FD49B', recent: 0 },
  coffee: { id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 0 },
};
const category = (id: string | null) => (id ? CATS[id] : undefined);

const row = (over: Record<string, unknown>) => ({
  transaction_id: 't', date: '2026-07-01', authorized_date: '2026-07-01', description: '', merchant_name: '',
  amount: -10, account_id: 'a1', account_name: 'ANZ', category: 'groceries', status: 'posted', type: 'purchase',
  counts_to_budget: true, ...over,
});

const WOOLIES = row({ transaction_id: 'w', merchant_name: 'Woolworths', description: 'WOOLWORTHS', category: 'groceries', amount: -42 });
const COFFEE = row({ transaction_id: 'c', merchant_name: 'ST Ali', description: 'ST ALI', category: 'coffee', amount: -8.5 });

function txData(over: Partial<{ transactions: unknown[]; isLoading: boolean; isError: boolean }> = {}) {
  return {
    transactions: [WOOLIES, COFFEE], category, balances: new Map(),
    isLoading: false, isError: false, isFetching: false, refetch: jest.fn(), refetchStale: jest.fn(), ...over,
  };
}

beforeEach(() => { mockTx = txData(); });

const type = (q: string) => fireEvent.changeText(screen.getByPlaceholderText('Search transactions'), q);

it('typing filters the list to matching rows', () => {
  render(<Transactions />);
  expect(screen.getByText('-$42.00')).toBeTruthy();
  expect(screen.getByText('-$8.50')).toBeTruthy();

  type('wool');
  expect(screen.getByText('-$42.00')).toBeTruthy();   // Woolworths matches
  expect(screen.queryByText('-$8.50')).toBeNull();    // coffee filtered out
});

it('matches by category name, not just merchant', () => {
  render(<Transactions />);
  type('cafes');                                       // the coffee row's category is "Cafes & Coffee"
  expect(screen.getByText('-$8.50')).toBeTruthy();
  expect(screen.queryByText('-$42.00')).toBeNull();
});

it('matches by amount', () => {
  render(<Transactions />);
  type('8.50');
  expect(screen.getByText('-$8.50')).toBeTruthy();
  expect(screen.queryByText('-$42.00')).toBeNull();
});

it('the ✕ clears the search and restores the full list', () => {
  render(<Transactions />);
  type('wool');
  expect(screen.queryByText('-$8.50')).toBeNull();

  fireEvent.press(screen.getByLabelText('Clear search'));
  expect(screen.getByText('-$42.00')).toBeTruthy();
  expect(screen.getByText('-$8.50')).toBeTruthy();
});

it('a query with no matches shows the empty state and no rows', () => {
  render(<Transactions />);
  type('zzzzz');
  expect(screen.getByTestId('transactions-no-results')).toBeTruthy();
  expect(screen.queryByText('-$42.00')).toBeNull();
  expect(screen.queryByText('-$8.50')).toBeNull();
});

it('entering selection mode clears an active search (the box hides, so no secret filter)', () => {
  render(<Transactions />);
  type('wool');
  expect(screen.queryByText('-$8.50')).toBeNull();

  fireEvent.press(screen.getByText('Select'));
  // The search box is gone in selection mode, and the list is back to the full set. In selection
  // mode the row body is a11y-hidden (the checkbox owns the label), so assert on the checkboxes.
  expect(screen.queryByPlaceholderText('Search transactions')).toBeNull();
  expect(screen.getByLabelText('Select Woolworths')).toBeTruthy();
  expect(screen.getByLabelText('Select ST Ali')).toBeTruthy();
});
});

// ===== WHIT-291 selection mode (folded from transactionsSelectMode.screen.test.tsx) =====
// A "Select" button swaps the rows for checkboxes; toggling rows tracks a set; the action bar's
// "Re-categorize" hands those ids to the picker (openMultiPicker) and leaves selection mode;
// "Cancel" exits. Asserts on the module-scope `mockOpenMultiPicker` (wired into the shared
// `../context` stub). `CAT` reused from module scope (byte-identical).
describe('Transactions — selection mode (WHIT-291)', () => {
const row = (id: string, merchant: string) => ({
  transaction_id: id, date: '2026-07-01', authorized_date: '2026-07-01',
  description: merchant.toUpperCase(), merchant_name: merchant, amount: -42, account_id: 'a1',
  account_name: 'ANZ', category: 'groceries', status: 'posted', type: 'purchase', counts_to_budget: true,
});
const category = (id: string | null) => (id === 'groceries' ? CAT : undefined);

function txData(over: Partial<{ transactions: unknown[] }> = {}) {
  return { transactions: [], category, isLoading: false, isError: false, isFetching: false, refetch: jest.fn(), refetchStale: jest.fn(), ...over };
}

beforeEach(() => {
  mockOpenMultiPicker.mockClear();
  mockTx = txData({ transactions: [row('t1', 'Woolworths'), row('t2', 'Coles')] });
});

it('there is no selection UI until "Select" is tapped', () => {
  render(<Transactions />);
  expect(screen.getByText('Select')).toBeTruthy();
  expect(screen.queryByLabelText('Select Woolworths')).toBeNull(); // no checkboxes yet
});

it('Select enters selection mode; toggling rows updates the count; Re-categorize hands the ids to the picker', () => {
  render(<Transactions />);
  fireEvent.press(screen.getByText('Select'));

  // Even a categorized row (Woolworths → groceries) is selectable in this mode.
  fireEvent.press(screen.getByLabelText('Select Woolworths'));
  fireEvent.press(screen.getByLabelText('Select Coles'));
  expect(screen.getByText('2 selected')).toBeTruthy();

  fireEvent.press(screen.getByLabelText('Select Coles')); // untoggle one
  expect(screen.getByText('1 selected')).toBeTruthy();

  fireEvent.press(screen.getByLabelText('Re-categorize selected transactions'));
  expect(mockOpenMultiPicker).toHaveBeenCalledWith(['t1']);
});

it('Re-categorize does nothing with an empty selection (disabled)', () => {
  render(<Transactions />);
  fireEvent.press(screen.getByText('Select'));
  fireEvent.press(screen.getByLabelText('Re-categorize selected transactions'));
  expect(mockOpenMultiPicker).not.toHaveBeenCalled();
});

it('Cancel leaves selection mode and clears the checkboxes', () => {
  render(<Transactions />);
  fireEvent.press(screen.getByText('Select'));
  expect(screen.getByLabelText('Select Woolworths')).toBeTruthy();

  fireEvent.press(screen.getByText('Cancel'));
  expect(screen.queryByLabelText('Select Woolworths')).toBeNull();
  expect(screen.getByText('Select')).toBeTruthy();
});
});
