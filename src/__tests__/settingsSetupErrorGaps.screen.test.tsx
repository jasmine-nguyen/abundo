// WHIT-198 GAPS (authored by qa) — the adversarial half of the "honest — + Retry" work that
// the implementer's settingsQueryGaps suite does NOT already cover. Their suite locks the
// CATEGORIES-only hard failure (b), the recover-via-Retry path (c) and cache-first (d). This
// file adds the mirror + ordering + fan-out cases:
//   [A5] loan-row-ONLY failure → loan "—", categories keeps its real count, retry present;
//   [A6] a single-row failure's Retry still re-issues BOTH server reads (refetch fan-out);
//   [A7] one row errored while the OTHER is still loading → the isLoading gate wins, rows
//        show "…" (never a premature "—");
//   [A8] hook-level: BOTH per-row error flags true on a 500, then BOTH false after success;
//   [A9] the profile / Automation rules / Pay cycle / alerts / Log out rows stay rendered
//        + the Log out affordance stays usable DURING a categories outage (why there is no
//        full-screen error card).
// ../api + ../auth + ../context + expo-router mocked; real QueryClientProvider.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { Text } from 'react-native';
import { render, screen, renderHook, act, waitFor, fireEvent } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockSignOut = jest.fn();
jest.mock('../auth', () => ({
  getStatus: () => 'authed',
  subscribe: () => () => {},
  getCurrentUser: () => null,
  signOut: () => mockSignOut(),
}));

const mockFetchCategories = jest.fn<() => Promise<unknown>>();
const mockFetchLoanFacts = jest.fn<() => Promise<unknown>>();
jest.mock('../api', () => ({
  fetchCategories: () => mockFetchCategories(),
  fetchLoanFacts: () => mockFetchLoanFacts(),
  listEnrichments: () => Promise.resolve([{ id: 'r1', field: 'description', operator: 'contains', value: 'X', categoryId: 'c' }]),
  fetchPayCycle: () => Promise.resolve({ length: 14, last_pay_date: '2024-01-03' }),
}));

// rules length 1 so the Automation-rules row shows a stable "1" during an outage; real
// selectors (loanFactsReady) + composite deps otherwise.
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return {
    ...actual,
    useAppContext: () => ({ rules: [{ id: 'r1' }], cycleName: () => 'Fortnightly', alerts: true, toggleAlerts: jest.fn(), setSheet: jest.fn() }),
  };
});

const mockReplace = jest.fn();
jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return { useRouter: () => ({ push: jest.fn(), replace: mockReplace }), useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]) };
});

import Settings from '../../app/(tabs)/settings';
import { useSettingsScreenData } from '../queries';

// A sibling observer sharing the same QueryClient as Settings — it renders a marker the instant
// categoriesError flips true. That's the deterministic anchor for the "error landed WHILE still
// loading" state, which the gated error card deliberately makes invisible on Settings itself.
function ErrorProbe() {
  const { categoriesError } = useSettingsScreenData();
  return categoriesError ? <Text testID="probe-cats-errored">x</Text> : null;
}

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

// [A5] mirror of the implementer's categories-only case, for the LOAN row. Before the fix the
// loan row collapsed to a misleading "Set up"; reverting settings.tsx' loan cell to
// `loanReady ? 'Edit' : 'Set up'` brings "Set up" back and drops the "—", failing this.
describe('loan-row-ONLY hard failure (categories fine)', () => {
  it('loan shows "—" + retry, categories keeps its real count (no fake "Set up")', async () => {
    mockFetchLoanFacts.mockReset().mockRejectedValue(new Error('API error: 500'));
    render(<QueryClientProvider client={makeClient(false)}><Settings /></QueryClientProvider>);

    expect(await screen.findByText('2')).toBeTruthy();        // categories count intact
    expect(screen.getByText('—')).toBeTruthy();               // loan row honestly unknown
    expect(screen.queryByText('Set up')).toBeNull();          // WHIT-198: not the misleading "Set up"
    expect(screen.queryByText('Edit')).toBeNull();
    expect(screen.queryByText('…')).toBeNull();               // load settled → no endless "…"
    expect(screen.getByTestId('settings-setup-error')).toBeTruthy();
    expect(screen.getByTestId('settings-setup-retry')).toBeTruthy();
  });
});

// [A6] a SINGLE errored row must still refetch BOTH server reads on Retry (the composite
// refetch fans out to every query). If refetch only re-fired the errored loan query, the
// categories read would NOT be re-issued — this counts both mocks to prove the fan-out.
describe('Retry after a single-row failure re-issues BOTH reads', () => {
  it('loan-only failure → Retry refetches categories AND loan facts', async () => {
    mockFetchLoanFacts.mockReset().mockRejectedValue(new Error('API error: 500'));
    render(<QueryClientProvider client={makeClient(false)}><Settings /></QueryClientProvider>);

    const retry = await screen.findByTestId('settings-setup-retry');
    await screen.findByText('2');                             // categories loaded once
    const catsBefore = mockFetchCategories.mock.calls.length; // == 1
    const loanBefore = mockFetchLoanFacts.mock.calls.length;  // == 1

    mockFetchLoanFacts.mockResolvedValue(READY_FACTS); // re-arm the loan read (no reset → keep the call count)
    fireEvent.press(retry);

    await waitFor(() => expect(screen.getByText('Edit')).toBeTruthy()); // loan recovered
    expect(mockFetchCategories.mock.calls.length).toBe(catsBefore + 1);  // the healthy row refetched too
    expect(mockFetchLoanFacts.mock.calls.length).toBe(loanBefore + 1);
    expect(screen.queryByTestId('settings-setup-error')).toBeNull();     // affordance gone
  });
});

// [A7] ordering / isLoading gate: categories errors FAST while loan facts are still pending. The
// per-row error flag can be true WHILE the composite is still loading — and neither the row ("…"
// wins over "—") nor the inline error card (gated on !isLoading) may surface the failure yet. We
// assert this at the HOOK boundary (deterministic: we can wait for categoriesError to land), then
// on the screen (both rows "…", no "—", no error card while loading). A screen-only "…" sample is
// racy against the sibling Automation-rules row's cold-load "0", so the hook check is the anchor.
describe('one row errored while the other is still loading', () => {
  it('hook: categoriesError flips true while isLoading stays true (loan still pending)', async () => {
    mockFetchCategories.mockReset().mockRejectedValue(new Error('API error: 500'));
    mockFetchLoanFacts.mockReset().mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = renderHook(() => useSettingsScreenData(), { wrapper: hookWrapper(makeClient(false)) });

    await waitFor(() => expect(result.current.categoriesError).toBe(true)); // the error landed…
    expect(result.current.isLoading).toBe(true); // …but the screen is still loading (loan pending)
    expect(result.current.loanReadyError).toBe(false); // the pending read hasn't errored
  });

  it('screen: withholds the error card while still loading, then surfaces it once loading ends', async () => {
    let resolveLoan!: (v: unknown) => void;
    mockFetchCategories.mockReset().mockRejectedValue(new Error('API error: 500'));
    mockFetchLoanFacts.mockReset().mockReturnValue(new Promise((res) => { resolveLoan = res; })); // held pending
    render(
      <QueryClientProvider client={makeClient(false)}>
        <ErrorProbe />
        <Settings />
      </QueryClientProvider>,
    );

    // Deterministic anchor: wait until categoriesError has ACTUALLY flipped true (loan still pending).
    await screen.findByTestId('probe-cats-errored');
    // ...yet the composite is still loading → the gate withholds the card. Without `!isLoading` the
    // card would already be co-rendering with the "…" rows here — this is the gate's fail-on-revert.
    expect(screen.queryByTestId('settings-setup-error')).toBeNull();
    expect(screen.queryByText('—')).toBeNull(); // rows still "…", no premature dash

    // let loan settle → isLoading false, categoriesError still true → the card + "—" now surface
    await act(async () => { resolveLoan(READY_FACTS); });
    expect(await screen.findByTestId('settings-setup-error')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
  });
});

// [A8] hook-level enumeration of BOTH per-row flags: a 500 on both reads → both true; a
// successful Retry → both false. Complements the screen tests at the data-source boundary.
describe('hook surfaces both per-row error flags together', () => {
  it('both flags true on a dual 500, both false after a successful refetch', async () => {
    mockFetchCategories.mockReset().mockRejectedValue(new Error('API error: 500'));
    mockFetchLoanFacts.mockReset().mockRejectedValue(new Error('API error: 500'));
    const { result } = renderHook(() => useSettingsScreenData(), { wrapper: hookWrapper(makeClient(false)) });

    await waitFor(() => expect(result.current.categoriesError).toBe(true));
    expect(result.current.loanReadyError).toBe(true);
    expect(result.current.isLoading).toBe(false); // both settled (errored) → not loading

    mockFetchCategories.mockReset().mockResolvedValue(CATS);
    mockFetchLoanFacts.mockReset().mockResolvedValue(READY_FACTS);
    await act(async () => { result.current.refetch(); });

    await waitFor(() => expect(result.current.categoriesError).toBe(false));
    expect(result.current.loanReadyError).toBe(false);
    expect(result.current.categoriesCount).toBe(2);
    expect(result.current.loanReady).toBe(true);
  });
});

// [A9] the reason WHIT-198 uses an INLINE row-level "—"/retry and not a full-screen error
// card: every non-server row must stay rendered + usable during a categories outage.
describe('non-server rows stay usable during a categories outage', () => {
  it('profile, Automation rules, Pay cycle, Log out all render + Log out still fires', async () => {
    mockFetchCategories.mockReset().mockRejectedValue(new Error('API error: 500'));
    render(<QueryClientProvider client={makeClient(false)}><Settings /></QueryClientProvider>);

    await screen.findByTestId('settings-setup-error');    // outage is live
    expect(await screen.findByText('Edit')).toBeTruthy(); // the OTHER server row (loan) settled fine
    expect(await screen.findByText('1')).toBeTruthy();    // Automation rules count still renders
    expect(screen.getByText('Signed in')).toBeTruthy();   // profile still shows (getCurrentUser → null)
    expect(screen.getByText('Fortnightly')).toBeTruthy(); // Pay cycle name unaffected
    expect(screen.getByText('Log out')).toBeTruthy();

    fireEvent.press(screen.getByTestId('settings-logout')); // Log out still works mid-outage
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('/');
  });
});
