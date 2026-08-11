// WHIT-188 — the Budgets screen on the new query layer. Proves the behaviours that
// matter: data comes from the auth-gated queries, a transient 5xx self-heals (no stuck
// banner), a sustained failure shows an inline retry, budgets window on the REAL cycle
// length, and nothing fetches before login. ../api + ../auth + expo-router mocked; the
// screen renders under a real QueryClientProvider so the actual query behaviour runs.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act, waitFor, renderHook } from '@testing-library/react-native';
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

// api: controllable fetchers. The three Budgets reads (fetchBudgets/Categories/PayCycle) drive
// the screen; a call to any OTHER screen endpoint would throw, so a green render proves the
// screen fetches ONLY its own reads. fetchTransactions + fetchBudgetTransactions are part of the
// mocked-module UNION added for the folded WHIT-72 detail-hook tests (useBudgetDetailScreenData);
// the Budgets screen never calls them, so they are inert for every non-detail test here.
const mockFetchBudgets = jest.fn<(days: number) => Promise<unknown>>();
const mockFetchCategories = jest.fn<() => Promise<unknown>>();
const mockFetchPayCycle = jest.fn<() => Promise<unknown>>();
const mockFetchTransactions = jest.fn<() => Promise<unknown>>();
const mockFetchBudgetTransactions = jest.fn<(id: string) => Promise<unknown>>();
jest.mock('../api', () => ({
  fetchBudgets: (...a: unknown[]) => mockFetchBudgets(...(a as [number])),
  fetchCategories: () => mockFetchCategories(),
  fetchPayCycle: () => mockFetchPayCycle(),
  fetchTransactions: () => mockFetchTransactions(),
  fetchBudgetTransactions: (id: string) => mockFetchBudgetTransactions(id),
}));

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Budgets from '../../app/(tabs)/budgets';
// The REAL query hooks (../api + ../auth mocked above) — driven directly by the folded WHIT-72
// tests via renderHook; the same regime the screen renders under.
import { useBudgetsScreenData, useBudgetDetailScreenData } from '../queries';

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

// ===== WHIT-221 (folded from budgetsSubcategory.screen.test.tsx) — same ../auth/../api/expo-router
// regime (real QueryClient). Divergent fixtures (car/parent + parking/sub, PAY_CYCLE len 14) and the
// indent-style helpers are block-scoped here so they shadow the module coffee fixtures for these two. =====
describe('WHIT-221 parent→sub tree + de-duped hero (folded from budgetsSubcategory)', () => {
  // Car (parent) rolled-up spend 75 of 200; Parking (sub of Car) 30 of 50. Same bucket.
  const PAY_CYCLE = { length: 14, last_pay_date: '2026-07-01' };
  const CATS = [
    { id: 'car', name: 'Car', bucket: 'Living', icon: 'car', color: '#7fd1b9', recent: 3, parent: null },
    { id: 'parking', name: 'Parking', bucket: 'Living', icon: 'car', color: '#7fd1b9', recent: 1, parent: 'car' },
  ];
  const BUDGETS = {
    car: { target: 200, posted: 75, pending: 0 },
    parking: { target: 50, posted: 30, pending: 0 },
  };

  // Flatten a host element's style prop (array | object | StyleSheet-ref) into one object.
  // StyleSheet.create refs spread to nothing; only inline objects (the indent block) carry
  // through — exactly what we want to detect.
  function flatStyle(node: any): Record<string, unknown> {
    const s = node?.props?.style;
    const arr = Array.isArray(s) ? s : [s];
    return arr.reduce((acc, cur) => (cur && typeof cur === 'object' ? { ...acc, ...cur } : acc), {} as Record<string, unknown>);
  }
  // Walk up from a text node and return the first ancestor inline style carrying a numeric
  // marginLeft (the depth indent block), or {} if none — the parent row has no indent block.
  function indentStyleFor(name: string): Record<string, unknown> {
    let node: any = screen.getByText(name);
    for (let i = 0; i < 8 && node; i++) {
      const st = flatStyle(node);
      if (typeof st.marginLeft === 'number') return st;
      node = node.parent;
    }
    return {};
  }

  beforeEach(() => {
    mockFetchBudgets.mockReset().mockResolvedValue(BUDGETS);
    mockFetchCategories.mockReset().mockResolvedValue(CATS);
    mockFetchPayCycle.mockReset().mockResolvedValue(PAY_CYCLE);
  });

  it('[A26] hero de-dups: the "of" pill counts the parent cap once, not parent + sub', async () => {
    renderBudgets();
    expect(await screen.findByText('Car')).toBeTruthy();
    expect(screen.getByText('Parking')).toBeTruthy();      // both rows render
    expect(screen.getByText('of $200')).toBeTruthy();      // Car only
    expect(screen.queryByText('of $250')).toBeNull();      // NOT Car + Parking
    // Reverting the `depth === 0` guard makes totBudget 250 -> the pill flips to "of $250".
  });

  it('[A27] the child row is indented and the parent row is not', async () => {
    renderBudgets();
    await screen.findByText('Car');
    expect(indentStyleFor('Car').marginLeft ?? 0).toBe(0);   // depth 0 -> no indent block
    const child = indentStyleFor('Parking');
    expect(child.marginLeft).toBe(18);                       // depth 1 -> 1 * 18
    expect(child.borderLeftWidth).toBe(2);                   // indent rail present
  });
});

// ===== WHIT-72 (folded from budgetsPayCycleError.screen.test.tsx) — the payCycleError guard,
// driven via renderHook on the REAL hooks (../api + ../auth mocked; NO expo-router mock originally —
// the shared module-scope expo-router mock is inert here because ../queries never imports it).
// makeClient/wrapper/fixtures block-scoped so they don't collide with the module helpers. =====
describe('WHIT-72 payCycleError guard (folded from budgetsPayCycleError)', () => {
  const CATS = [{ id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 0 }];
  const PAY_CYCLE = { length: 30, last_pay_date: '2026-07-01' };
  const BUDGETS = { coffee: { target: 100, posted: 40, pending: 10 } };

  function makeClient() {
    return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: Infinity } } });
  }
  const wrapper = (client: QueryClient) =>
    ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

  beforeEach(() => {
    mockFetchBudgets.mockReset().mockResolvedValue(BUDGETS);
    mockFetchCategories.mockReset().mockResolvedValue(CATS);
    mockFetchPayCycle.mockReset().mockResolvedValue(PAY_CYCLE);
    mockFetchTransactions.mockReset().mockResolvedValue([]);
    mockFetchBudgetTransactions.mockReset().mockResolvedValue([]);
  });

  describe('useBudgetsScreenData — payCycleError guard (WHIT-72)', () => {
    it('first-load payCycle failure (never-succeeded → data undefined) → payCycleError is TRUE', async () => {
      mockFetchPayCycle.mockReset().mockRejectedValue(new Error('API error: 503'));
      const { result } = renderHook(() => useBudgetsScreenData(), { wrapper: wrapper(makeClient()) });

      await waitFor(() => expect(result.current.isError).toBe(true));
      // The signal the screen keys its error card on — locked directly (existing tests only
      // assert the aggregate isError). data===undefined ⇒ no cached cycle to trust.
      expect(result.current.payCycleError).toBe(true);
    });

    it('BACKGROUND payCycle refetch failure over a cached cycle → payCycleError stays FALSE, rows + last-good cycle survive (cache-first)', async () => {
      // First load succeeds → cycle (len 30) + budgets cached. Then a refetch of the pay cycle
      // fails: TanStack v5 RETAINS the last-good data, so data!==undefined ⇒ payCycleError must
      // stay FALSE and the rows keep rendering against the last-good cycle. A bare `.isError`
      // (no data guard) would flip this true and blank cached budgets — the exact regression.
      const { result } = renderHook(() => useBudgetsScreenData(), { wrapper: wrapper(makeClient()) });
      await waitFor(() => expect(result.current.budgets).toHaveLength(1));
      expect(result.current.cycleLen).toBe(30);

      mockFetchPayCycle.mockReset().mockRejectedValue(new Error('API error: 503'));
      await act(async () => { result.current.refetch(); });
      await waitFor(() => expect(result.current.isError).toBe(true)); // the failed payCycle refetch propagates

      expect(result.current.payCycleError).toBe(false); // <-- data retained → NOT a first-load error
      expect(result.current.cycleLen).toBe(30);         // last-good cycle still drives the hero
      expect(result.current.budgets).toHaveLength(1);   // cached rows survive
    });

    it('BOTH payCycle AND budgets fail on first load → error via both paths (payCycleError AND isError)', async () => {
      mockFetchPayCycle.mockReset().mockRejectedValue(new Error('API error: 503'));
      mockFetchBudgets.mockReset().mockRejectedValue(new Error('API error: 500'));
      const { result } = renderHook(() => useBudgetsScreenData(), { wrapper: wrapper(makeClient()) });

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.payCycleError).toBe(true);
      expect(result.current.budgets).toHaveLength(0);
    });
  });

  describe('useBudgetDetailScreenData — payCycleError guard (WHIT-72)', () => {
    it('BACKGROUND payCycle refetch failure over a cached cycle → payCycleError stays FALSE (cache-first, same guard as Budgets)', async () => {
      const { result } = renderHook(() => useBudgetDetailScreenData('coffee'), { wrapper: wrapper(makeClient()) });
      await waitFor(() => expect(result.current.budgets).toHaveLength(1));
      expect(result.current.cycleLen).toBe(30);

      mockFetchPayCycle.mockReset().mockRejectedValue(new Error('API error: 503'));
      await act(async () => { result.current.refetch(); });
      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(result.current.payCycleError).toBe(false);
      expect(result.current.cycleLen).toBe(30);
      expect(result.current.budgets).toHaveLength(1);
    });

    it('first-load payCycle failure → payCycleError is TRUE (detail blanks on it)', async () => {
      mockFetchPayCycle.mockReset().mockRejectedValue(new Error('API error: 503'));
      const { result } = renderHook(() => useBudgetDetailScreenData('coffee'), { wrapper: wrapper(makeClient()) });
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.payCycleError).toBe(true);
    });
  });
});
