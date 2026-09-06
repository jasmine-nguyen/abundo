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
import { RefreshControl } from 'react-native';
import { HEADER_BODY_HEIGHT } from '../motion/useNavBarsHeader';

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
const mockShowToast = jest.fn();
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return {
    ...actual,
    useAppContext: () => ({
      retryLoad: jest.fn(),
      openPicker: jest.fn(),
      openMultiPicker: mockOpenMultiPicker,
      showToast: mockShowToast,
      category: (id: string | null) => (id === 'groceries' ? CAT : undefined),
    }),
  };
});

jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return {
    useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]),
    useRouter: () => ({ push: jest.fn() }),
  };
});

import Transactions from '../../app/(tabs)/transactions';

const refetch = jest.fn();
const refetchStale = jest.fn();
// Pull-to-refresh now drives refetchList (list refresh) + refreshLiveBalances (the live bank call);
// onRefresh clears the spinner in a .finally() once BOTH settle — never off isFetching (WHIT-363).
// Tests hold the resolvers so they can assert the spinner is up mid-pull and down once it settles.
let resolveList: () => void = () => {};
let resolveBalances: () => void = () => {};
let rejectBalances: (e?: unknown) => void = () => {};
const refetchList = jest.fn(() => new Promise<void>((res) => { resolveList = res; }));
const refreshLiveBalances = jest.fn(() => new Promise<void>((res, rej) => { resolveBalances = res; rejectBalances = rej; }));
// Settle the in-flight pull so onRefresh's .finally() runs and clears the spinner.
async function settlePull() {
  await act(async () => { resolveList(); resolveBalances(); await Promise.resolve(); });
}
// Settle a pull whose LIVE balance call fails (list ok, balances reject — onRefresh catches it).
async function settlePullWithBalancesError() {
  await act(async () => { resolveList(); rejectBalances(new Error('API error: 502')); await Promise.resolve(); });
}

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

// WHIT: on the Uncategorized tab, when everything is filed ("All caught up"), Load More must
// not render even though older history still exists — there's nothing to page toward there.
it('hides Load More on the uncategorized "all caught up" empty state, even with more history', () => {
  // Default rows are all categorized -> uncategorizedCount 0 -> the empty state shows.
  mockTx = txData({ hasMore: true });
  render(<Transactions />);
  fireEvent.press(screen.getByTestId('tab-uncategorized'));
  expect(screen.getByText('All caught up')).toBeTruthy();
  expect(screen.queryByTestId('transactions-load-more')).toBeNull(); // fail-on-revert: reappears without the guard
});

// The guard is the EMPTY case, not the whole tab: with real uncategorized rows showing, Load
// More still pages older history (so a buried uncategorized charge isn't stranded).
it('keeps Load More on the uncategorized tab when there ARE uncategorized rows', () => {
  const uncategorizedRow = { ...row('t1'), category: null }; // no resolvable category -> uncategorized
  mockTx = txData({ transactions: [uncategorizedRow], hasMore: true });
  render(<Transactions />);
  fireEvent.press(screen.getByTestId('tab-uncategorized'));
  expect(screen.queryByText('All caught up')).toBeNull();
  expect(screen.getByTestId('transactions-load-more')).toBeTruthy();
});
});

// ===== WHIT-363 pull-to-refresh (folded from transactionsPullRefresh.screen.test.tsx) =====
// The Transactions list is query-fed, and pull-to-refresh refetches the VISIBLE LIST ONLY (the
// query). WHIT-363: the pull spinner is driven by a local `pulling` flag set ONLY on a user pull,
// not by the query's raw `isFetching`. Reuses the module-scope mocks; `refetch`/`refetchStale`/
// `CAT`/`ROW` reused from module scope (byte-identical).
describe('Transactions — pull-to-refresh (WHIT-363)', () => {
const category = (id: string | null) => (id === 'groceries' ? CAT : undefined);

function txData(over: Partial<{ transactions: unknown[]; isFetching: boolean; isLoading: boolean }> = {}) {
  return { transactions: [], category, isLoading: false, isError: false, isFetching: false, refetch, refetchStale, refetchList, refreshLiveBalances, ...over };
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
  refetchList.mockClear();
  refreshLiveBalances.mockClear();
  mockShowToast.mockClear();
  mockTx = txData();
});

it('pull-to-refresh refreshes the visible list AND the live balances — not the Retry re-read', async () => {
  const { UNSAFE_getByType } = render(<Transactions />);
  pull(UNSAFE_getByType);
  expect(refetchList).toHaveBeenCalledTimes(1);         // the list (feed + categories)
  expect(refreshLiveBalances).toHaveBeenCalledTimes(1); // the LIVE bank call
  expect(refetch).not.toHaveBeenCalled();               // Retry's cheap stored re-read is NOT the pull
  await settlePull();
});

// A background/focus refetch (refetchStale) runs with NO user pull. The spinner is owned by the
// local `pulling` flag (never isFetching, WHIT-363), so it stays DOWN when the user hasn't pulled.
it('a background/focus refetch (non-empty list, NO pull) does NOT raise the spinner', () => {
  mockTx = txData({ transactions: [ROW], isFetching: true });
  const { UNSAFE_getByType } = render(<Transactions />);
  expect(isSpinning(UNSAFE_getByType)).toBe(false);
});

// A finger-pull raises the spinner while the pull is in flight — `pulling` drives it.
it('a genuine user pull raises the spinner while it is in flight', async () => {
  mockTx = txData({ transactions: [ROW] });
  const { UNSAFE_getByType } = render(<Transactions />);
  pull(UNSAFE_getByType);
  expect(isSpinning(UNSAFE_getByType)).toBe(true); // up while the list + live call are pending
  await settlePull();
});

// The spinner clears once the pull's work (list + live balances) SETTLES — via onRefresh's
// .finally(), not isFetching. Fail-on-revert: drop the `.finally(() => setPulling(false))` and the
// spinner never clears → this goes RED.
it('the pull spinner clears when the pull settles', async () => {
  mockTx = txData({ transactions: [ROW] });
  const { UNSAFE_getByType } = render(<Transactions />);
  pull(UNSAFE_getByType);
  expect(isSpinning(UNSAFE_getByType)).toBe(true);
  await settlePull();
  expect(isSpinning(UNSAFE_getByType)).toBe(false);
});

it('the pull spinner does NOT spin during a cold load (empty list) — the inline spinner owns it', async () => {
  mockTx = txData({ transactions: [], isLoading: true });
  const { UNSAFE_getByType } = render(<Transactions />);
  pull(UNSAFE_getByType);
  expect(isSpinning(UNSAFE_getByType)).toBe(false); // empty list → pull spinner suppressed
  await settlePull();
});

it('the spinner is down when the user has not pulled', () => {
  mockTx = txData({ transactions: [ROW] });
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
  return { transactions: [], category, isLoading: false, isError: false, isFetching: false, refetch, refetchStale, refetchList, refreshLiveBalances, ...over };
}

type GetByType = (t: typeof RefreshControl) => { props: any };
function pull(getByType: GetByType) { act(() => { getByType(RefreshControl).props.onRefresh(); }); }
const isSpinning = (getByType: GetByType) => getByType(RefreshControl).props.refreshing;

beforeEach(() => {
  refetch.mockClear();
  refetchStale.mockClear();
  refetchList.mockClear();
  refreshLiveBalances.mockClear();
  mockShowToast.mockClear();
  mockTx = txData();
});

// [E1] The pull's LIVE balance call FAILS. onRefresh catches it (toasts) and its .finally() still
// clears the spinner once the pull settles — the spinner must not stick just because the live call
// rejected, and the list keeps its rows (a balances failure never blanks it).
// Fail-on-revert: drop the `.catch`/`.finally` in onRefresh → the rejection escapes / the spinner
// never clears → this assertion flips to true → RED.
it('[E1] a pull whose live balance call ERRORS still clears the spinner (and toasts)', async () => {
  mockTx = txData({ transactions: [ROW] });
  const { UNSAFE_getByType } = render(<Transactions />);
  pull(UNSAFE_getByType);
  expect(isSpinning(UNSAFE_getByType)).toBe(true);
  await settlePullWithBalancesError(); // live call rejects, list ok
  expect(isSpinning(UNSAFE_getByType)).toBe(false); // cleared, not stuck on error
  expect(mockShowToast).toHaveBeenCalledWith('Could not refresh balances. Showing last saved.');
});

// [E3] A pull DURING the cold-load window (empty list still loading) must NOT double-spin with
// the inline loading spinner — the RefreshControl stays down and the centred inline spinner owns
// the empty first-load state. The `&& transactions.length > 0` guard on `refreshing` enforces it.
// Fail-on-revert: drop that guard (refreshing={pulling}) → a pull with an empty list raises the
// RefreshControl too → this assertion flips to true → RED.
it('[E3] a pull during a cold load does NOT raise the pull spinner (inline spinner owns it)', async () => {
  mockTx = txData({ transactions: [], isLoading: true });
  const { UNSAFE_getByType } = render(<Transactions />);
  pull(UNSAFE_getByType);
  expect(isSpinning(UNSAFE_getByType)).toBe(false); // empty list → pull spinner suppressed
  await settlePull();
});

// [E2] After one full pull cycle (spin → clear), a SECOND pull must spin again and clear — the
// `pulling` flag must reset, not latch permanently.
// Fail-on-revert: drop `setPulling(true)` from onRefresh → the second pull can't raise the
// spinner → the mid-test `true` assertion goes RED (same guard as sibling test 3, but this
// locks that it survives a prior completed cycle).
it('[E2] a second pull after the first resolves still spins and clears', async () => {
  mockTx = txData({ transactions: [ROW] });
  const { UNSAFE_getByType } = render(<Transactions />);
  // First cycle.
  pull(UNSAFE_getByType);
  expect(isSpinning(UNSAFE_getByType)).toBe(true);
  await settlePull();
  expect(isSpinning(UNSAFE_getByType)).toBe(false);
  // Second cycle — a fresh pull spins and clears again (the flag reset, didn't latch).
  pull(UNSAFE_getByType);
  expect(isSpinning(UNSAFE_getByType)).toBe(true);  // second pull raises it again
  await settlePull();
  expect(isSpinning(UNSAFE_getByType)).toBe(false); // and clears again
});

// [E4] WHIT-489 divergent gate: the Transactions RefreshControl gates on
// `pulling && transactions.length > 0`, so a pull on a SETTLED EMPTY list (not loading, no rows)
// must NOT raise the pull spinner — the divergence from the Accounts tab, which DOES spin on its
// settled-empty list. [E3] only exercises the LOADING-empty case, where the accounts gate
// (`!showSpinner`) and this screen's gate (`length > 0`) AGREE (both false) — so nothing else
// catches Transactions accidentally adopting the accounts `!showSpinner` gate. This locks the
// distinguishing case. Fail-on-revert: switch transactions.tsx to `refreshing={pulling && !showSpinner}`
// → a settled-empty pull reports refreshing=true → RED.
it('[E4] a pull on the SETTLED EMPTY list does NOT raise the pull spinner (length>0 gate)', async () => {
  mockTx = txData({ transactions: [], isLoading: false }); // settled + empty, NOT a cold load
  const { UNSAFE_getByType } = render(<Transactions />);
  pull(UNSAFE_getByType);
  expect(refetchList).toHaveBeenCalledTimes(1);          // the pull DID fire (pulling=true)
  expect(refreshLiveBalances).toHaveBeenCalledTimes(1);
  expect(isSpinning(UNSAFE_getByType)).toBe(false);      // ...but the spinner is gated off by length>0
  await settlePull();
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

// ===== WHIT-491 — Load More × search & tab-switch (QA gaps) =====
// Adversarial companion to the `Transactions — Load More` block above. That block already locks
// the NO-SEARCH cases (all-caught-up hides Load More; real uncategorized rows keep it). These lock
// the GAPS: the search interaction (guard is computed pre-search-filter), the tab round-trip, and
// the isLoadingMore-leak on the empty state. Reuses the module-scope ../queries / ../context /
// expo-router mocks. NOT a duplicate of the sibling block — no search / tab-toggle / spinner-leak
// case exists there.
describe('Transactions — Load More × search & tab-switch (WHIT-491)', () => {
  const mockLoadMore = jest.fn();
  const category = (id: string | null) => (id === 'groceries' ? CAT : undefined);
  const catRow = (id: string) => ({
    transaction_id: id, date: '2026-07-01', authorized_date: '2026-07-01',
    description: 'WOOLWORTHS', merchant_name: 'Woolworths', amount: -42, account_id: 'a1',
    account_name: 'ANZ', category: 'groceries', status: 'posted', type: 'purchase', counts_to_budget: true,
  });
  function txData(over: Partial<{ transactions: unknown[]; hasMore: boolean; isLoadingMore: boolean }> = {}) {
    return {
      transactions: [catRow('t1')], category, balances: new Map(),
      isLoading: false, isError: false, isFetching: false, refetch: jest.fn(), refetchStale: jest.fn(),
      hasMore: false, loadMore: mockLoadMore, isLoadingMore: false, ...over,
    };
  }
  const type = (q: string) => fireEvent.changeText(screen.getByPlaceholderText('Search transactions'), q);
  beforeEach(() => { mockLoadMore.mockClear(); mockTx = txData(); });

  // [A-S1] Uncategorized tab, everything filed (count 0), a search typed that matches nothing.
  // uncategorizedCount is computed over the FULL list (transactions.tsx reads `transactions`, not
  // the searched list), so it stays 0 under any query. "All caught up" still owns the empty state,
  // the "No matches" block is suppressed, and Load More stays hidden. Fail-on-revert: drop the
  // Load More guard and it reappears here.
  it('[A-S1] uncategorized + all-filed + active search: All caught up shows, No matches suppressed, Load More hidden', () => {
    mockTx = txData({ hasMore: true }); // rows all categorized -> uncategorizedCount 0
    render(<Transactions />);
    fireEvent.press(screen.getByTestId('tab-uncategorized'));
    type('zzzzz');
    expect(screen.getByText('All caught up')).toBeTruthy();
    expect(screen.queryByTestId('transactions-no-results')).toBeNull(); // not double-shown with All caught up
    expect(screen.queryByTestId('transactions-load-more')).toBeNull();  // guard holds under an active search
  });

  // [A-S2] Uncategorized tab WITH real uncategorized rows (count > 0), search matches nothing:
  // identical to the All-tab behaviour, unchanged by the fix — "No matches" shows AND Load More
  // still shows (guard is false because count > 0, so a search miss must not strand paging).
  // Fail-on-revert: widen the guard to hide on the whole uncategorized tab and Load More vanishes.
  it('[A-S2] uncategorized + uncategorized-rows + search miss: No matches shows AND Load More still shows', () => {
    const uncategorized = { ...catRow('t1'), category: null }; // no resolvable category -> uncategorized
    mockTx = txData({ transactions: [uncategorized], hasMore: true });
    render(<Transactions />);
    fireEvent.press(screen.getByTestId('tab-uncategorized'));
    type('zzzzz');
    expect(screen.getByTestId('transactions-no-results')).toBeTruthy();
    expect(screen.queryByText('All caught up')).toBeNull();
    expect(screen.getByTestId('transactions-load-more')).toBeTruthy(); // unchanged from the All tab
  });

  // [A-T1] Round-trip All -> Uncategorized -> All with more history and 0 uncategorized: Load More
  // shows on All, hides on Uncategorized (all caught up), shows again on returning to All — the
  // guard tracks the live tab, not a one-way latch.
  it('[A-T1] All -> Uncategorized -> All toggles Load More off then back on (0 uncategorized, hasMore)', () => {
    mockTx = txData({ hasMore: true });
    render(<Transactions />);
    expect(screen.getByTestId('transactions-load-more')).toBeTruthy();  // All: shown
    fireEvent.press(screen.getByTestId('tab-uncategorized'));
    expect(screen.queryByTestId('transactions-load-more')).toBeNull();  // Uncategorized empty: hidden
    fireEvent.press(screen.getByTestId('tab-all'));
    expect(screen.getByTestId('transactions-load-more')).toBeTruthy();  // back to All: shown again
  });

  // [A-LS1] The empty-state guard beats isLoadingMore: on the uncategorized all-caught-up state,
  // even with a page mid-load, NEITHER the Load More button NOR its spinner leaks (the whole block
  // is gated off before the isLoadingMore branch).
  it('[A-LS1] uncategorized all-caught-up + isLoadingMore: neither Load More button nor its spinner renders', () => {
    mockTx = txData({ hasMore: true, isLoadingMore: true });
    render(<Transactions />);
    fireEvent.press(screen.getByTestId('tab-uncategorized'));
    expect(screen.getByText('All caught up')).toBeTruthy();
    expect(screen.queryByTestId('transactions-load-more')).toBeNull();
    expect(screen.queryByTestId('transactions-load-more-spinner')).toBeNull(); // no spinner leak
  });
});
