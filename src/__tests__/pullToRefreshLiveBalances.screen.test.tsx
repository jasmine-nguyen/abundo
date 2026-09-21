// WHIT-363 / WHIT-212 — pull-to-refresh LIVE balances, adversarial gaps the implementer's tests miss.
// Renders the REAL Accounts screen (its own bottom-bar tab now) on a real QueryClient (mirrors the
// WHIT-190a screen describe in transactionsScreenData.screen.test.tsx). The account cards render on
// mount — no segment to press. The existing suite proves the HOOK seeds -250 and that a failed pull
// "keeps last-good"/toasts at the LIST level; these prove it on the RENDERED Accounts CARD (the dollar
// figure the user sees), that a success toasts "Balances up to date", that the LIST still refreshes when the live
// call fails (allSettled), that a second pull after a FAILED first is not latched, and that an
// in-flight stored GET can't clobber the freshly-seeded live value.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { RefreshControl } from 'react-native';
import { render, screen, act, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let mockAuthStatus = 'authed';
jest.mock('../auth', () => ({ getStatus: () => mockAuthStatus, subscribe: () => () => {} }));

const mockFetchTransactionsFeed = jest.fn<(cursor?: string) => Promise<unknown>>();
const mockFetchCategories = jest.fn<() => Promise<unknown>>();
const mockFetchAccountBalances = jest.fn<() => Promise<unknown>>();
const mockRefreshAccountBalances = jest.fn<() => Promise<unknown>>();
const mockShowToast = jest.fn<(m: string) => void>();
jest.mock('../api', () => ({
  fetchTransactionsFeed: (cursor?: string) => mockFetchTransactionsFeed(cursor),
  fetchCategories: () => mockFetchCategories(),
  fetchTransactions: () => Promise.resolve([]),
  fetchAccountBalances: () => mockFetchAccountBalances(),
  refreshAccountBalances: () => mockRefreshAccountBalances(),
}));

const CATS = [{ id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7FD49B', recent: 0 }];
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return {
    ...actual,
    useAppContext: () => ({ retryLoad: jest.fn(), openMultiPicker: jest.fn(), showToast: mockShowToast, category: (id: string | null) => CATS.find((c) => c.id === id) }),
  };
});

jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return { useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]), useRouter: () => ({ push: jest.fn() }) };
});

import Accounts from '../../app/(tabs)/accounts';

const TXNS = [{
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'WOOLWORTHS', merchant_name: 'Woolworths', amount: -42, account_id: 'a1',
  account_name: 'ANZ', category: 'groceries', status: 'posted', type: 'purchase', counts_to_budget: true,
}];

function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: Infinity } } });
}
function renderScreen(client = makeClient()) {
  return render(React.createElement(QueryClientProvider, { client }, React.createElement(Accounts)));
}
const rc = () => screen.UNSAFE_getByType(RefreshControl);
const pull = async () => { await act(async () => { rc().props.onRefresh(); }); };

describe('pull-to-refresh LIVE balances on the rendered screen (WHIT-363 / WHIT-212 gaps)', () => {
  beforeEach(() => {
    mockAuthStatus = 'authed';
    mockFetchTransactionsFeed.mockReset().mockResolvedValue({ transactions: TXNS, nextCursor: null });
    mockFetchCategories.mockReset().mockResolvedValue(CATS);
    mockFetchAccountBalances.mockReset().mockResolvedValue([{ account_id: 'a1', amount: -100 }]);
    mockRefreshAccountBalances.mockReset();
    mockShowToast.mockReset();
  });

  // [G1] A SUCCESSFUL live pull moves the number the user sees on the Accounts card from the stored
  // -$100.00 to the freshly-fetched -$250.00 — the seeded cache actually reaches the render, not just
  // the hook. Fail-on-revert: drop `setQueryData(accountBalancesKey, fresh)` in refreshLiveBalances
  // and the card stays -$100.00 → the -$250.00 findBy never resolves → RED.
  it('[G1] a successful live pull updates the rendered Accounts card old→new', async () => {
    mockRefreshAccountBalances.mockResolvedValue([{ account_id: 'a1', amount: -250 }]);
    renderScreen();
    expect(await screen.findByText('-$100.00')).toBeTruthy();    // card loaded, stored balance shown

    await pull();
    expect(await screen.findByText('-$250.00')).toBeTruthy();    // card now shows the live number
    expect(screen.queryByText('-$100.00')).toBeNull();           // old number gone
  });

  // [G2] A SUCCESSFUL live pull confirms itself with the "Balances up to date" toast. The pull often
  // returns the same number (the balance didn't move, or the server's 60s throttle returned the stored
  // values), so this toast is the only signal it actually ran. The FAILURE toast ("Showing last saved")
  // stays a separate affordance and must NOT fire on success.
  // Fail-on-revert: drop the successMessage arg on the Accounts screen (or the `.then` toast in the
  // hook) → no toast fires on success → RED.
  it('[G2] a successful live pull toasts "Balances up to date"', async () => {
    mockRefreshAccountBalances.mockResolvedValue([{ account_id: 'a1', amount: -250 }]);
    renderScreen();
    expect(await screen.findByText('-$100.00')).toBeTruthy();
    await pull();
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Balances up to date'));
    expect(mockShowToast).not.toHaveBeenCalledWith('Could not refresh balances. Showing last saved.');
  });

  // [G3] OFFLINE / failed live pull: the card must keep the EXACT prior number (-$100.00), never blank
  // to the pending "—" or change — and it toasts. Locks the WHIT-212 "never blank the cards" promise at
  // the pixel the user reads, past "isError is false". Fail-on-revert: swallow the throw and
  // setQueryData(accountBalancesKey, undefined/[]) on failure → the card blanks to "—" → RED.
  it('[G3] an offline live pull keeps the exact prior card number and toasts', async () => {
    mockRefreshAccountBalances.mockRejectedValue(new Error('Network request failed'));
    renderScreen();
    expect(await screen.findByText('-$100.00')).toBeTruthy();

    await pull();
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Could not refresh balances. Showing last saved.'));
    expect(screen.getByText('-$100.00')).toBeTruthy();           // unchanged, not blanked
    expect(screen.queryByText('—')).toBeNull();                  // never fell back to the pending dash
  });

  // [G4] The pull refreshes the transaction LIST even when the live balance call REJECTS — the two are
  // independent (Promise.allSettled, and refetchList is invoked regardless of the balance outcome).
  // Fail-on-revert: gate refetchList behind the balance success → the feed is not re-fetched on a
  // failed pull → the call-count assertion reddens.
  it('[G4] the list still refetches when the live balance call fails', async () => {
    mockRefreshAccountBalances.mockRejectedValue(new Error('API error: 502'));
    renderScreen();
    expect(await screen.findByText('-$100.00')).toBeTruthy();
    const feedCallsBefore = mockFetchTransactionsFeed.mock.calls.length;

    await pull();
    await waitFor(() => expect(mockRefreshAccountBalances).toHaveBeenCalledTimes(1)); // live call fired & failed
    await waitFor(() => expect(mockFetchTransactionsFeed.mock.calls.length).toBeGreaterThan(feedCallsBefore));
  });

  // [G5] A second pull after a FAILED first still fires the live call AND raises/clears the spinner —
  // the `pulling` flag is not latched by the first failure. Fail-on-revert: drop the `.finally` clear
  // → the 2nd pull's spinner never comes up / never clears → the mid-pull `true` or final `false` reddens.
  it('[G5] a second pull after a FAILED first re-fires the live call and clears the spinner', async () => {
    renderScreen();
    expect(await screen.findByText('-$100.00')).toBeTruthy();

    // First pull: live call rejects.
    const d1 = deferred<unknown>();
    mockRefreshAccountBalances.mockReturnValueOnce(d1.promise);
    await act(async () => { rc().props.onRefresh(); });
    expect(rc().props.refreshing).toBe(true);                    // spinner up mid-pull
    await act(async () => { d1.reject(new Error('offline')); await Promise.resolve(); });
    await waitFor(() => expect(rc().props.refreshing).toBe(false)); // cleared despite the failure
    expect(mockShowToast).toHaveBeenCalledTimes(1);

    // Second pull: not latched — spins again, applies its fresh number, clears again.
    const d2 = deferred<unknown>();
    mockRefreshAccountBalances.mockReturnValueOnce(d2.promise);
    await act(async () => { rc().props.onRefresh(); });
    expect(rc().props.refreshing).toBe(true);                    // proves the flag reset
    await act(async () => { d2.resolve([{ account_id: 'a1', amount: -250 }]); await Promise.resolve(); });
    expect(await screen.findByText('-$250.00')).toBeTruthy();    // 2nd pull's live number reached the card
    await waitFor(() => expect(rc().props.refreshing).toBe(false));
    expect(mockRefreshAccountBalances).toHaveBeenCalledTimes(2);
  });

  // [G6] The in-flight stored GET race: a pull whose live POST resolves BEFORE the still-pending
  // initial stored GET must NOT be clobbered when that GET lands late. refreshLiveBalances cancels the
  // in-flight balances query before seeding, so the late -100 is discarded and the card stays -$250.00.
  // Fail-on-revert: remove `await queryClient.cancelQueries({ queryKey: accountBalancesKey })` and the
  // late stored GET can overwrite the seed → the card reverts to -$100.00 → RED (timing-dependent, but
  // reliably reproduces under the sharded coverage run).
  it('[G6] a late-resolving stored GET does NOT clobber the freshly-pulled live value', async () => {
    // Hold the INITIAL stored balances GET open so it's still in flight when the user pulls.
    const storedGet = deferred<unknown>();
    mockFetchAccountBalances.mockReset().mockReturnValueOnce(storedGet.promise);
    // The live pull resolves immediately with the fresh number.
    mockRefreshAccountBalances.mockResolvedValue([{ account_id: 'a1', amount: -250 }]);

    renderScreen();
    // Card up (feed resolved); balances GET still pending → the pending dash.
    expect(await screen.findByText('—')).toBeTruthy();

    await pull();                                                  // live POST seeds -250, cancels the GET
    expect(await screen.findByText('-$250.00')).toBeTruthy();

    // The stale stored GET finally lands with the OLD number — it must be ignored (query was cancelled).
    // Flush with a real macrotask so react-query fully commits the resolved fetch if it were going to.
    await act(async () => { storedGet.resolve([{ account_id: 'a1', amount: -100 }]); await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.getByText('-$250.00')).toBeTruthy();            // still the live value, not clobbered
    expect(screen.queryByText('-$100.00')).toBeNull();
  });
});
