// WHIT-188 — the Budgets screen on the new query layer. Proves the behaviours that
// matter: data comes from the auth-gated queries, a transient 5xx self-heals (no stuck
// banner), a sustained failure shows an inline retry, budgets window on the REAL cycle
// length, and nothing fetches before login. ../api + ../auth + expo-router mocked; the
// screen renders under a real QueryClientProvider so the actual query behaviour runs.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { routerSpies, resetRouter } from './support/routerMock';

// auth: controllable status + a real subscribe, so the "fires on login" test can flip it.
let mockAuthStatus = 'authed';
const mockAuthListeners = new Set<() => void>();
jest.mock('../auth', () => ({
  getStatus: () => mockAuthStatus,
  subscribe: (l: () => void) => {
    mockAuthListeners.add(l);
    return () => mockAuthListeners.delete(l);
  },
}));
function setAuth(next: string) {
  mockAuthStatus = next;
  mockAuthListeners.forEach((l) => l());
}

// api: controllable fetchers. Only the three Budgets reads exist — a call to any other
// endpoint would be an undefined function and throw, so a green render proves the
// screen fetches ONLY its own reads.
const mockFetchBudgets = jest.fn<(days: number) => Promise<unknown>>();
const mockFetchCategories = jest.fn<() => Promise<unknown>>();
const mockFetchPayCycle = jest.fn<() => Promise<unknown>>();
jest.mock('../api', () => ({
  fetchBudgets: (...a: unknown[]) => mockFetchBudgets(...(a as [number])),
  fetchCategories: () => mockFetchCategories(),
  fetchPayCycle: () => mockFetchPayCycle(),
}));

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Budgets from '../../app/(tabs)/budgets';

// length 30 (NOT the default 14) so "windowed on the real length" genuinely proves
// budgets waited for the pay cycle rather than fetching with the seeded default.
const PAY_CYCLE = { length: 30, last_pay_date: '2026-07-01' };
const CATS = [{ id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 52 }];
const BUDGETS = { coffee: { target: 100, posted: 40, pending: 10 } };

function makeClient(retry: boolean | number = false) {
  // staleTime mirrors the app default (data stays fresh) so the focus refetch is a
  // no-op here, exactly as in prod — otherwise the default staleTime:0 makes every
  // query instantly stale and refetchStale fires a spurious second fetch.
  return new QueryClient({ defaultOptions: { queries: { retry, retryDelay: 1, staleTime: 60_000, gcTime: Infinity } } });
}
function renderBudgets(client = makeClient()) {
  return render(React.createElement(QueryClientProvider, { client }, React.createElement(Budgets)));
}

beforeEach(() => {
  mockAuthStatus = 'authed';
  mockAuthListeners.clear();
  mockFetchBudgets.mockReset().mockResolvedValue(BUDGETS);
  mockFetchCategories.mockReset().mockResolvedValue(CATS);
  mockFetchPayCycle.mockReset().mockResolvedValue(PAY_CYCLE);
  resetRouter();
});

it('renders budget rows from the queries, fetched in parallel with the pay cycle', async () => {
  renderBudgets();
  expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
  // WHIT-72: budgets fetch in PARALLEL now (flat key, no gate), so they fire with the default
  // length (14) before the cycle resolves — and never refetch to 30. The server ignores the
  // length anyway (it derives the window itself), so the rendered rows are still correct.
  expect(mockFetchBudgets).toHaveBeenCalledWith(14);
  expect(mockFetchBudgets).toHaveBeenCalledTimes(1);
  expect(mockFetchPayCycle).toHaveBeenCalledTimes(1);
  expect(mockFetchCategories).toHaveBeenCalledTimes(1);
});

it('does not render the redundant per-row "target" caption (the pace tick is labelled once in the legend)', async () => {
  // WHIT-281: a per-row "target" caption pinned under the moving pace tick overlapped the
  // right-aligned pace status when the tick sat far right. It was redundant — the tick is
  // already explained once, in the top legend — so it was removed.
  renderBudgets();
  await screen.findByText('Cafes & Coffee');
  expect(screen.queryAllByText('target')).toHaveLength(0); // the overlapping caption is gone
  expect(screen.getByText("Today's pace")).toBeTruthy();   // the tick is still explained (legend)
});

it('still renders the per-row pace STATUS after the caption removal (info kept, not lost)', async () => {
  // WHIT-281 — [A-pace] the fix removed the redundant \"target\" caption but the pace STATUS
  // ($X over/under budget) must survive. The logic layer proves budgetViews COMPUTES paceLabel;
  // this proves the screen still RENDERS it. Removing budgets.tsx:101 (the paceLabel <Text/>)
  // is invisible to the logic tests AND to the absence/legend test above — this is the guard.
  // Over-budget so the label is date-independent: spent 120 of 100 -> exactly "$20 over budget".
  mockFetchBudgets.mockReset().mockResolvedValue({ coffee: { target: 100, posted: 120, pending: 0 } });
  renderBudgets();
  await screen.findByText('Cafes & Coffee');
  expect(screen.getByText('$20 over budget')).toBeTruthy();
});

it('shows a spinner first, then the rows (cache-first render)', async () => {
  renderBudgets();
  expect(screen.getByTestId('budgets-loading')).toBeTruthy(); // nothing cached yet
  expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
});

it('a transient 5xx retries with backoff and self-heals — no error shown', async () => {
  mockFetchBudgets
    .mockReset()
    .mockRejectedValueOnce(new Error('API error: 503'))
    .mockResolvedValue(BUDGETS);
  renderBudgets(makeClient(2)); // retry enabled (fast delay)
  expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
  expect(screen.queryByTestId('budgets-error')).toBeNull();
  expect(mockFetchBudgets).toHaveBeenCalledTimes(2); // first failed, retry succeeded
});

it('a sustained failure shows the inline error, and Retry recovers', async () => {
  mockFetchBudgets.mockReset().mockRejectedValue(new Error('API error: 503'));
  renderBudgets(makeClient(false)); // no retry → straight to the error state
  expect(await screen.findByTestId('budgets-error')).toBeTruthy();

  // WHIT-198: the Retry now routes through the shared RetryButton, so it carries the
  // button role + a screen-reader label (which the old bare Pressable lacked).
  const retry = screen.getByTestId('budgets-retry');
  expect(retry.props.accessibilityRole).toBe('button');
  expect(retry.props.accessibilityLabel).toBe('Retry loading your budgets');

  mockFetchBudgets.mockReset().mockResolvedValue(BUDGETS);
  fireEvent.press(retry);
  expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
});

it('does not fetch before login, then fires the moment auth flips to authed', async () => {
  mockAuthStatus = 'anon';
  renderBudgets();
  // Disabled queries never call their fetchers.
  expect(mockFetchPayCycle).not.toHaveBeenCalled();
  expect(mockFetchBudgets).not.toHaveBeenCalled();
  expect(mockFetchCategories).not.toHaveBeenCalled();

  await act(async () => {
    setAuth('authed');
  });
  expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
  expect(mockFetchPayCycle).toHaveBeenCalled();
});

it('the add-budget button navigates to the picker', async () => {
  renderBudgets();
  await screen.findByText('Cafes & Coffee');
  fireEvent.press(screen.getByText('Add a budget'));
  expect(routerSpies.push).toHaveBeenCalledWith('/budget/pick');
});

it('hides a Savings-bucket budget end-to-end and keeps it out of the hero total (WHIT-201)', async () => {
  // A stored Savings budget (reachable by re-bucketing an already-budgeted category, or
  // a deep-linked write) must not render a row AND must not inflate the "of $X" pill.
  // Exercises the whole query -> selectBudgets -> budgetViews -> render pipeline; reverting
  // the budgetViews Savings skip (src/context.tsx) makes both assertions fail.
  mockFetchCategories.mockReset().mockResolvedValue([
    { id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 52 },
    { id: 'nest_egg', name: 'Nest Egg', bucket: 'Savings', icon: 'home', color: '#C7A8F0', recent: 0 },
  ]);
  mockFetchBudgets.mockReset().mockResolvedValue({
    coffee: { target: 100, posted: 40, pending: 10 },
    nest_egg: { target: 2000, posted: 0, pending: 0 },
  });
  renderBudgets();
  expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
  expect(screen.queryByText('Nest Egg')).toBeNull();      // Savings row hidden
  expect(screen.getByText('of $100')).toBeTruthy();       // spend budget only
  expect(screen.queryByText('of $2,100')).toBeNull();     // NOT spend + Savings target
});

// ===== WHIT-188 adversarial gaps (folded in) — partial failure, empty state, auth-lock, cache
// invalidation, focus over-fetch, and the payCycle-failure dead-end. Same regime (mocked auth+api,
// real QueryClient); the gaps' local router mock was rewired onto the shared routerMock harness. =====

describe('partial failure', () => {
  it('budgets read fails while pay cycle succeeds → inline error + Retry (not a spinner)', async () => {
    mockFetchBudgets.mockReset().mockRejectedValue(new Error('API error: 503'));
    renderBudgets(makeClient(false));
    expect(await screen.findByTestId('budgets-error')).toBeTruthy();
    expect(screen.getByTestId('budgets-retry')).toBeTruthy();
    // WHIT-72: budgets fetches in PARALLEL now (not gated on payCycle), so it fires with the
    // DEFAULT length (14) before the cycle resolves — and the flat key means it never
    // refetches to 30. The server ignores the length anyway, so the response is still correct.
    expect(mockFetchBudgets).toHaveBeenCalledWith(14);
    expect(screen.queryByTestId('budgets-loading')).toBeNull();
  });

  it('categories read fails → inline error (rows cannot render without their category)', async () => {
    mockFetchCategories.mockReset().mockRejectedValue(new Error('API error: 500'));
    renderBudgets(makeClient(false));
    expect(await screen.findByTestId('budgets-error')).toBeTruthy();
    expect(screen.queryByText('Cafes & Coffee')).toBeNull();
  });
});

describe('empty budgets', () => {
  it('empty rollup {} → empty state (hero + Add a budget), not a spinner or error', async () => {
    mockFetchBudgets.mockReset().mockResolvedValue({});
    renderBudgets();
    expect(await screen.findByText('Add a budget')).toBeTruthy();
    expect(screen.queryByTestId('budgets-loading')).toBeNull();
    expect(screen.queryByTestId('budgets-error')).toBeNull();
    expect(screen.queryByText('Cafes & Coffee')).toBeNull();
    expect(screen.getByText('days left')).toBeTruthy(); // hero still renders
  });
});

describe('focus refetch', () => {
  it('does not storm: fresh data + focus effect → each fetcher called exactly once', async () => {
    renderBudgets(); // staleTime 60s → refetchStale is a no-op
    expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockFetchPayCycle).toHaveBeenCalledTimes(1);
    expect(mockFetchBudgets).toHaveBeenCalledTimes(1);
    expect(mockFetchCategories).toHaveBeenCalledTimes(1);
  });
});

describe('auth transition mid-session', () => {
  it('authed→locked keeps cached rows and fires no new fetch (no doomed 401 retry)', async () => {
    renderBudgets();
    expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
    const before = mockFetchBudgets.mock.calls.length;

    await act(async () => {
      setAuth('locked');
    });
    expect(screen.getByText('Cafes & Coffee')).toBeTruthy();
    expect(screen.queryByTestId('budgets-error')).toBeNull();
    expect(mockFetchBudgets).toHaveBeenCalledTimes(before);
  });
});

describe('save → cache invalidation', () => {
  it("invalidate ['budgets'] refetches the budgets query", async () => {
    // edit.tsx invalidates the module-singleton queryClient (same instance _layout mounts
    // — a static import, so identity is guaranteed). Behaviourally, invalidating ['budgets']
    // must refetch the (flat, WHIT-72) budgets query; a local client with no gcTime timer
    // proves that without leaking a background timer into the worker.
    const client = makeClient();
    render(React.createElement(QueryClientProvider, { client }, React.createElement(Budgets)));
    expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
    const before = mockFetchBudgets.mock.calls.length;

    await act(async () => {
      client.invalidateQueries({ queryKey: ['budgets'] }); // what edit.tsx does after a save
    });
    await waitFor(() => expect(mockFetchBudgets.mock.calls.length).toBeGreaterThan(before));
  });
});

// WHIT-72: budgets no longer waterfalls behind the pay cycle.
describe('parallel fetch (no waterfall)', () => {
  it('budgets fetches immediately with the default length, not gated on the pay cycle', async () => {
    // Hold the pay cycle unresolved; budgets must STILL fire (in parallel), with the default
    // length (14). On the OLD gated code fetchBudgets would not be called until payCycle
    // resolved — so this fails on revert.
    let resolvePayCycle: (v: unknown) => void = () => {};
    mockFetchPayCycle.mockReset().mockReturnValue(new Promise((r) => { resolvePayCycle = r; }));
    renderBudgets();

    await waitFor(() => expect(mockFetchBudgets).toHaveBeenCalled());
    expect(mockFetchBudgets).toHaveBeenCalledWith(14);   // default length — cycle not yet loaded
    expect(mockFetchPayCycle).toHaveBeenCalledTimes(1);  // fired in parallel, still pending

    await act(async () => { resolvePayCycle(PAY_CYCLE); }); // settle to avoid an act() leak
  });
});

// WHIT-72: a pay-cycle length change refetches budgets EXACTLY once (the explicit
// invalidate), not twice. With the flat key, writing a new-length pay cycle no longer
// shifts the budgets key, so it doesn't itself trigger a refetch — only the invalidate does.
describe('length change refetches once, not twice', () => {
  it('writing a new-length pay cycle does NOT refetch; the invalidate is the single refresh', async () => {
    const client = makeClient();
    render(React.createElement(QueryClientProvider, { client }, React.createElement(Budgets)));
    expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
    const afterLoad = mockFetchBudgets.mock.calls.length;

    // persistPayCycle writes the new-length cycle into the cache. With the flat key this must
    // NOT trigger a budgets refetch on its own (the old windowed key WOULD have — refetch #1).
    await act(async () => {
      client.setQueryData(['payCycle'], { length: 14, last_pay_date: '2026-07-01' });
    });
    await act(async () => { await Promise.resolve(); });
    expect(mockFetchBudgets.mock.calls.length).toBe(afterLoad); // no key-shift refetch

    // ...and the explicit invalidate persistPayCycle fires is the SINGLE refresh.
    await act(async () => { client.invalidateQueries({ queryKey: ['budgets'] }); });
    await waitFor(() => expect(mockFetchBudgets.mock.calls.length).toBe(afterLoad + 1));
  });
});

// A sustained payCycle failure must show the inline error + Retry, never a spinner and never
// budgets-against-a-wrong-cycle. WHIT-72: budgets now fetch in PARALLEL, so on a payCycle
// failure the rows would load (against the DEFAULT cycle) and suppress the old `isError &&
// rows.length === 0` error — the payCycleError signal restores the error here. Fail-on-revert:
// drop payCycleError from showError and this reverts to rendering rows with a wrong days-left.
describe('payCycle failure must show the error, not budgets on a wrong cycle', () => {
  it('sustained payCycle failure → inline error + Retry (payCycleError), never a spinner', async () => {
    mockFetchPayCycle.mockReset().mockRejectedValue(new Error('API error: 503'));
    renderBudgets(makeClient(false));
    expect(await screen.findByTestId('budgets-error')).toBeTruthy();
    expect(screen.getByTestId('budgets-retry')).toBeTruthy();
    expect(screen.queryByTestId('budgets-loading')).toBeNull();
  });
});
