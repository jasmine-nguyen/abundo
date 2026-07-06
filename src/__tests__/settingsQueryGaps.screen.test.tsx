// WHIT-191a GAPS (authored by qa) — the adversarial half of useSettingsScreenData /
// Settings that the implementer's happy-path suite skips:
//   (1) sustained hard failure: hook surfaces isError + falls back to count 0, and the
//       screen renders the misleading "0" the "…" logic was meant to prevent (critique #1);
//   (2) partial-load flash: loan cached-ready but categories pending → isLoading true;
//   (3) read-your-write: a save's invalidate refetches the active Settings observer and
//       the loan row stays "Edit";
//   (4) focus refetchStale is stale-gated (no request storm) but does refetch when stale;
//   (5) refetch()/invalidate-scope at the read layer (categories NOT refetched).
// ../api + ../auth + ../context + expo-router mocked; real QueryClientProvider.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, renderHook, act, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

jest.mock('../auth', () => ({
  getStatus: () => 'authed',
  subscribe: () => () => {},
  getCurrentUser: () => null,
  signOut: jest.fn(),
}));

const mockFetchCategories = jest.fn<() => Promise<unknown>>();
const mockFetchLoanFacts = jest.fn<() => Promise<unknown>>();
jest.mock('../api', () => ({
  fetchCategories: () => mockFetchCategories(),
  fetchLoanFacts: () => mockFetchLoanFacts(),
  listEnrichments: () => Promise.resolve([{ id: 'r1', field: 'description', operator: 'contains', value: 'X', categoryId: 'c' }]),
  fetchPayCycle: () => Promise.resolve({ length: 14, last_pay_date: '2024-01-03' }),
}));

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
});

describe('sustained hard failure (no self-heal)', () => {
  it('hook surfaces isError, drops isLoading, and falls back to count 0', async () => {
    mockFetchCategories.mockReset().mockRejectedValue(new Error('API error: 500'));
    const { result } = renderHook(() => useSettingsScreenData(), { wrapper: hookWrapper(makeClient(false)) });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.isLoading).toBe(false); // errored query is not "loading" → no endless "…"
    expect(result.current.categoriesCount).toBe(0);
  });

  it('Settings renders "0" (not "…") for Categories once the read has hard-failed', async () => {
    mockFetchCategories.mockReset().mockRejectedValue(new Error('API error: 500'));
    render(<QueryClientProvider client={makeClient(false)}><Settings /></QueryClientProvider>);

    // loan facts still resolve → "Edit" lets us wait past first paint deterministically.
    expect(await screen.findByText('Edit')).toBeTruthy();
    expect(screen.queryByText('…')).toBeNull(); // "…" cleared on error
    expect(screen.getByText('0')).toBeTruthy(); // categories fell back to a misleading 0 (critique #1)
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
