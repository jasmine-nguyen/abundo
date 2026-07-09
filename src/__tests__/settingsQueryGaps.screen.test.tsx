// WHIT-191a GAPS (authored by qa) — the adversarial half of useSettingsScreenData /
// Settings that the implementer's happy-path suite skips:
//   (1) sustained hard failure (WHIT-198): hook surfaces categoriesError and the screen
//       renders an honest "—" + inline Retry — NOT the misleading "0" it rendered before;
//   (2) partial-load flash: loan cached-ready but categories pending → isLoading true;
//   (3) read-your-write: a save's invalidate refetches the active Settings observer and
//       the loan row stays "Edit";
//   (4) focus refetchStale is stale-gated (no request storm) but does refetch when stale;
//   (5) refetch()/invalidate-scope at the read layer (categories NOT refetched).
// ../api + ../auth + ../context + expo-router mocked; real QueryClientProvider.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, renderHook, act, waitFor, fireEvent } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

jest.mock('../auth', () => ({
  getStatus: () => 'authed',
  subscribe: () => () => {},
  getCurrentUser: () => null,
  signOut: jest.fn(),
}));

const mockFetchCategories = jest.fn<() => Promise<unknown>>();
const mockFetchLoanFacts = jest.fn<() => Promise<unknown>>();
const mockListEnrichments = jest.fn<() => Promise<unknown>>();
jest.mock('../api', () => ({
  fetchCategories: () => mockFetchCategories(),
  fetchLoanFacts: () => mockFetchLoanFacts(),
  listEnrichments: () => mockListEnrichments(),
  fetchPayCycle: () => Promise.resolve({ length: 14, last_pay_date: '2024-01-03' }),
}));

const ONE_RULE = [{ id: 'r1', field: 'description', operator: 'contains', value: 'X', categoryId: 'c' }];

// Real selectors (loanFactsReady) + composite deps; stub only the store-backed rows.
// rules length 1 so the categories "0" under failure is unambiguous on screen.
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return {
    ...actual,
    useAppContext: () => ({ rules: [{ id: 'r1' }], cycleName: () => 'Fortnightly', alerts: true, toggleAlerts: jest.fn(), setSheet: jest.fn() }),
  };
});

jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return { useRouter: () => ({ push: jest.fn(), replace: jest.fn() }), useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]) };
});

import Settings from '../../app/(tabs)/settings';
import { useSettingsScreenData } from '../queries';

const CATS = [
  { id: 'a', name: 'A', bucket: 'Living', icon: 'cart', color: '#7FD49B', recent: 0 },
  { id: 'b', name: 'B', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 0 },
];
const READY_FACTS = { original: 500000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200 };

function makeClient(retry: boolean | number = false, staleTime = 60_000) {
  return new QueryClient({ defaultOptions: { queries: { retry, retryDelay: 1, staleTime, gcTime: Infinity } } });
}
const hookWrapper = (client: QueryClient) =>
  ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

beforeEach(() => {
  mockFetchCategories.mockReset().mockResolvedValue(CATS);
  mockFetchLoanFacts.mockReset().mockResolvedValue(READY_FACTS);
  mockListEnrichments.mockReset().mockResolvedValue(ONE_RULE);
});

describe('sustained hard failure (no self-heal)', () => {
  it('hook surfaces categoriesError (not a fake 0) and drops isLoading', async () => {
    mockFetchCategories.mockReset().mockRejectedValue(new Error('API error: 500'));
    const { result } = renderHook(() => useSettingsScreenData(), { wrapper: hookWrapper(makeClient(false)) });

    await waitFor(() => expect(result.current.categoriesError).toBe(true));
    expect(result.current.isLoading).toBe(false); // errored query is not "loading" → no endless "…"
    expect(result.current.loanReadyError).toBe(false); // loan facts still resolved → that row is fine
  });

  // WHIT-198 fail-on-revert: before the fix the categories row collapsed to a misleading "0".
  // Reverting settings.tsx to `String(categoriesCount)` brings the "0" back and fails this.
  it('Settings renders "—" + a Retry (not the misleading "0") once the read has hard-failed', async () => {
    mockFetchCategories.mockReset().mockRejectedValue(new Error('API error: 500'));
    render(<QueryClientProvider client={makeClient(false)}><Settings /></QueryClientProvider>);

    // loan facts still resolve → "Edit" lets us wait past first paint deterministically.
    expect(await screen.findByText('Edit')).toBeTruthy();
    expect(screen.queryByText('…')).toBeNull(); // "…" cleared on error
    expect(screen.queryByText('0')).toBeNull(); // WHIT-198: no longer a misleading 0
    expect(screen.getByText('—')).toBeTruthy(); // honest "unknown" on the categories row
    expect(screen.getByTestId('settings-setup-error')).toBeTruthy();
    expect(screen.getByTestId('settings-setup-retry')).toBeTruthy(); // and a working retry affordance
  });
});

describe('the inline Retry re-reads both server rows (WHIT-198)', () => {
  it('press Retry → categories + loan facts refetch and the rows recover', async () => {
    mockFetchCategories.mockReset().mockRejectedValue(new Error('API error: 500'));
    mockFetchLoanFacts.mockReset().mockRejectedValue(new Error('API error: 500'));
    render(<QueryClientProvider client={makeClient(false)}><Settings /></QueryClientProvider>);

    const retry = await screen.findByTestId('settings-setup-retry');
    await waitFor(() => expect(screen.getAllByText('—').length).toBe(2)); // both rows honestly unknown

    // re-arm both reads to succeed, then retry
    mockFetchCategories.mockReset().mockResolvedValue(CATS);
    mockFetchLoanFacts.mockReset().mockResolvedValue(READY_FACTS);
    fireEvent.press(retry);

    await waitFor(() => expect(screen.queryByText('—')).toBeNull()); // rows recovered
    expect(screen.getByText('2')).toBeTruthy(); // real categories count
    expect(screen.getByText('Edit')).toBeTruthy(); // loan facts ready again
    expect(screen.queryByTestId('settings-setup-error')).toBeNull(); // retry affordance gone
  });
});

describe('cache-first: a background-refetch failure keeps the last-good value (WHIT-198)', () => {
  it('does NOT surface categoriesError once a real count has been cached', async () => {
    const { result } = renderHook(() => useSettingsScreenData(), { wrapper: hookWrapper(makeClient(false, 0)) });
    await waitFor(() => expect(result.current.categoriesCount).toBe(2)); // first load succeeded

    // the NEXT read fails — but we already hold a cached count
    mockFetchCategories.mockReset().mockRejectedValue(new Error('API error: 503'));
    await act(async () => { result.current.refetchStale(); });
    await waitFor(() => expect(mockFetchCategories.mock.calls.length).toBe(1)); // the refetch fired + failed

    // firstLoadError guard: data is retained on a background-refetch failure → no "—", real count stays
    expect(result.current.categoriesError).toBe(false);
    expect(result.current.categoriesCount).toBe(2);
  });
});

describe('partial-load flash', () => {
  it('reports isLoading true while categories are pending even though loan facts are cached-ready', async () => {
    mockFetchCategories.mockReset().mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = renderHook(() => useSettingsScreenData(), { wrapper: hookWrapper(makeClient(false)) });

    await waitFor(() => expect(result.current.loanReady).toBe(true)); // loan settled first
    expect(result.current.isLoading).toBe(true); // ...but the whole screen (incl. loan row) still shows "…"
  });
});

describe('read-your-write with an active Settings observer', () => {
  it("invalidate after a save refetches the mounted observer and the loan row stays ready", async () => {
    const client = makeClient(false);
    const { result } = renderHook(() => useSettingsScreenData(), { wrapper: hookWrapper(client) });
    await waitFor(() => expect(result.current.loanReady).toBe(true));

    const before = mockFetchLoanFacts.mock.calls.length;
    const catBefore = mockFetchCategories.mock.calls.length;

    // Mirror the production write: setQueryData(next) + invalidate ONLY loanFacts.
    await act(async () => {
      client.setQueryData(['loanFacts'], READY_FACTS);
      await client.invalidateQueries({ queryKey: ['loanFacts'] });
    });

    await waitFor(() => expect(mockFetchLoanFacts.mock.calls.length).toBe(before + 1)); // active observer refetched
    expect(mockFetchCategories.mock.calls.length).toBe(catBefore); // invalidate was loanFacts-only
    expect(result.current.loanReady).toBe(true); // never flickers to "Set up" across the refetch
  });
});

describe('refetchStale focus gate', () => {
  it('does NOT refetch fresh (non-stale) queries — no request storm on focus', async () => {
    const { result } = renderHook(() => useSettingsScreenData(), { wrapper: hookWrapper(makeClient(false, 60_000)) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const cats = mockFetchCategories.mock.calls.length;
    const loan = mockFetchLoanFacts.mock.calls.length;
    await act(async () => { result.current.refetchStale(); });

    expect(mockFetchCategories.mock.calls.length).toBe(cats); // still fresh → skipped
    expect(mockFetchLoanFacts.mock.calls.length).toBe(loan);
  });

  it('DOES refetch both when they have gone stale', async () => {
    const { result } = renderHook(() => useSettingsScreenData(), { wrapper: hookWrapper(makeClient(false, 0)) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const cats = mockFetchCategories.mock.calls.length;
    const loan = mockFetchLoanFacts.mock.calls.length;
    await act(async () => { result.current.refetchStale(); });

    await waitFor(() => expect(mockFetchCategories.mock.calls.length).toBe(cats + 1));
    expect(mockFetchLoanFacts.mock.calls.length).toBe(loan + 1);
  });
});

// WHIT-198 follow-up — the Automation-rules row got the same honest-"—" + retry treatment as
// categories/loan (previously it only got the loading gate, so a sustained rules failure still
// showed a misleading "0").
describe('rules-row hard failure', () => {
  it('rules read fails → Automation rules shows "—" + the setup retry, others keep their values', async () => {
    mockListEnrichments.mockReset().mockRejectedValue(new Error('API error: 500'));
    render(<QueryClientProvider client={makeClient(false)}><Settings /></QueryClientProvider>);

    expect(await screen.findByText('2')).toBeTruthy(); // categories loaded (2), unaffected
    expect(screen.getByText('Edit')).toBeTruthy(); // loan loaded, unaffected
    expect(screen.getByText('—')).toBeTruthy(); // rules row honestly unknown
    expect(screen.queryByText('0')).toBeNull(); // WHIT-198: not a misleading 0
    expect(screen.getByTestId('settings-setup-error')).toBeTruthy();
  });

  it('the setup Retry re-reads the failed rules query too (fan-out includes rules)', async () => {
    mockListEnrichments.mockReset().mockRejectedValue(new Error('API error: 500'));
    render(<QueryClientProvider client={makeClient(false)}><Settings /></QueryClientProvider>);

    const retry = await screen.findByTestId('settings-setup-retry');
    await screen.findByText('—'); // rules failed → "—"

    mockListEnrichments.mockReset().mockResolvedValue(ONE_RULE); // re-arm the rules read
    fireEvent.press(retry);

    expect(await screen.findByText('1')).toBeTruthy(); // rules recovered to its real count
    expect(screen.queryByText('—')).toBeNull();
    expect(screen.queryByTestId('settings-setup-error')).toBeNull();
  });
});

// WHIT-198 follow-up — investigation: does simply returning to the Settings tab re-arm a row that
// hard-failed its first load, or is the Retry button the only path? Answer, locked here: a query
// that errored with NOTHING cached is STALE, so the focus `refetchStale()` DOES retry it. (A
// background-refetch failure over cached data is a different case — that keeps the cached value.)
describe('focus refetch re-arms a first-load failure', () => {
  it('a first-load-failed categories read is stale, so refetchStale() on focus retries + recovers it', async () => {
    mockFetchCategories.mockReset().mockRejectedValueOnce(new Error('API error: 500')).mockResolvedValue(CATS);
    const { result } = renderHook(() => useSettingsScreenData(), { wrapper: hookWrapper(makeClient(false)) });

    await waitFor(() => expect(result.current.categoriesError).toBe(true)); // first load failed, nothing cached
    const callsAfterFail = mockFetchCategories.mock.calls.length;

    await act(async () => { result.current.refetchStale(); }); // returning to the tab

    await waitFor(() => expect(result.current.categoriesError).toBe(false)); // recovered without pressing Retry
    expect(result.current.categoriesCount).toBe(2);
    expect(mockFetchCategories.mock.calls.length).toBe(callsAfterFail + 1); // focus DID re-issue the failed read
  });
});
