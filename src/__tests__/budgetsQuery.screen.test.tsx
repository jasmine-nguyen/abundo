// WHIT-188 — the Budgets screen on the new query layer. Proves the behaviours that
// matter: data comes from the auth-gated queries, a transient 5xx self-heals (no stuck
// banner), a sustained failure shows an inline retry, budgets window on the REAL cycle
// length, and nothing fetches before login. Real ../api over the fake server; ../auth +
// expo-router mocked; the screen renders under a real QueryClientProvider so the actual query
// behaviour runs.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { screen, fireEvent, act, waitFor, renderHook } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { makeClient, wrapper, pause } from './support/queryClient';
import { BUDGETS, BUDGET_PAY_CYCLE, seedBudgets, renderBudgets, renderLoadedBudgets, heroTotals } from './support/budgetsScreen';
import { routerSpies, resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { refreshInAct } from './support/renderWithQueries';
import { pinToday } from './support/clock';
import { pullControl, pullAndSettle } from './support/pull';
import { styleOf } from './support/layout';

// auth: controllable status + a real subscribe, so the "fires on login" test can flip it.
jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { setAuthStatus, setAuthStatusQuietly, resetAuth } from './support/authMock';

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

// The REAL query hooks (real ../api over the fake server, ../auth mocked above) — driven directly
// by the folded WHIT-72 tests via renderHook; the same regime the screen renders under.
import { useBudgetsScreenData, useBudgetDetailScreenData } from '../queries';
import { nextPayday } from '../payCycle';
import { COFFEE, SALARY, GROCERIES_RECORD } from './support/categories';
import { MINUS } from '../theme';

const server = installFakeServer();
// The Budgets reads. `/budgets?` (with the query mark) counts the rollup read only, never a
// budget's own transactions list.
const budgetReads = () => server.sentUnder('GET', '/budgets?');
const payCycleReads = () => server.sent('GET', '/paycycle');
const categoryReads = () => server.sent('GET', '/categories');

beforeEach(() => {
  resetAuth();
  // The shared pay cycle has length 30 (NOT the default 14), so "windowed on the real length"
  // genuinely proves budgets waited for the pay cycle rather than fetching with the default.
  seedBudgets(server);
  resetRouter();
});

it('renders budget rows from the queries, fetched in parallel with the pay cycle', async () => {
  await renderLoadedBudgets();
  // WHIT-72: budgets fetch in PARALLEL now (flat key, no gate), so they fire with the default
  // length (14) before the cycle resolves — and never refetch to 30. The server ignores the
  // length anyway (it derives the window itself), so the rendered rows are still correct.
  expect(server.sent('GET', '/budgets?days=14')).toHaveLength(1);
  expect(budgetReads()).toHaveLength(1);
  expect(payCycleReads()).toHaveLength(1);
  expect(categoryReads()).toHaveLength(1);
});

it('does not render the per-row "target" caption', async () => {
  // WHIT-281: a per-row "target" caption pinned under the moving pace tick overlapped the
  // right-aligned pace status when the tick sat far right, so it was removed.
  await renderLoadedBudgets();
  expect(screen.queryAllByText('target')).toHaveLength(0);
});

it('an over-budget row says the overspend once (WHIT-712)', async () => {
  // Over-budget so the amount is date-independent: spent 120 of 100 -> "$20" "over" on the amount,
  // and no repeated "$20 over budget" pace line. Rollover, so no spread link can start (WHIT-707).
  server.seed('/budgets', { coffee: { target: 100, posted: 120, pending: 0, rollover: true, carryover: 0 } });
  await renderLoadedBudgets();
  expect(screen.getByText('$20')).toBeTruthy();
  expect(screen.getByText('over')).toBeTruthy();
  expect(screen.queryByText('$20 over budget')).toBeNull();
});

it('shows a spinner first, then the rows (cache-first render)', async () => {
  renderBudgets();
  expect(screen.getByTestId('budgets-loading')).toBeTruthy(); // nothing cached yet
  expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
});

it('a transient 5xx retries with backoff and self-heals — no error shown', async () => {
  server.once('GET', '/budgets', { status: 503 });
  await renderLoadedBudgets(makeClient({ retry: 2 })); // retry enabled (fast delay)
  expect(screen.queryByTestId('budgets-error')).toBeNull();
  expect(budgetReads()).toHaveLength(2); // first failed, retry succeeded
});

it('a sustained failure shows the inline error, and Retry recovers', async () => {
  server.fail('/budgets', 503);
  renderBudgets(makeClient()); // no retry → straight to the error state
  expect(await screen.findByTestId('budgets-error')).toBeTruthy();

  // WHIT-198: the Retry now routes through the shared RetryButton, so it carries the
  // button role + a screen-reader label (which the old bare Pressable lacked).
  const retry = screen.getByTestId('budgets-retry');
  expect(retry.props.accessibilityRole).toBe('button');
  expect(retry.props.accessibilityLabel).toBe('Retry loading your budgets');

  server.once('GET', '/budgets', { body: BUDGETS }); // a queued reply goes out ahead of the failure
  fireEvent.press(retry);
  expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
});

it('a sustained failure sends a bounded number of requests (WHIT-668)', async () => {
  server.fail('/budgets', 503);
  renderBudgets(makeClient());
  expect(await screen.findByTestId('budgets-error')).toBeTruthy();
  await pause(200);
  expect(budgetReads()).toHaveLength(1);
});

it('does not fetch before login, then fires the moment auth flips to authed', async () => {
  setAuthStatusQuietly('anon');
  renderBudgets();
  // Disabled queries never call their fetchers.
  expect(payCycleReads()).toHaveLength(0);
  expect(budgetReads()).toHaveLength(0);
  expect(categoryReads()).toHaveLength(0);

  await act(async () => {
    setAuthStatus('authed');
  });
  expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
  expect(payCycleReads().length).toBeGreaterThan(0);
});

it('the header "+" button navigates to the picker (WHIT-711)', async () => {
  await renderLoadedBudgets();
  fireEvent.press(screen.getByLabelText('Add budget'));
  expect(routerSpies.push).toHaveBeenCalledWith('/budget/pick');
});

it('hides a Savings-bucket budget end-to-end and keeps it out of the hero total (WHIT-201)', async () => {
  // A stored Savings budget (reachable by re-bucketing an already-budgeted category, or
  // a deep-linked write) must not render a row AND must not inflate the "of $X" pill.
  // Exercises the whole query -> selectBudgets -> budgetViews -> render pipeline; reverting
  // the budgetViews Savings skip (src/context.tsx) makes both assertions fail.
  server.seed('/categories', [
    COFFEE,
    { id: 'nest_egg', name: 'Nest Egg', bucket: 'Savings', icon: 'home', color: '#C7A8F0' },
  ]);
  server.seed('/budgets', {
    coffee: { target: 100, posted: 40, pending: 10 },
    nest_egg: { target: 2000, posted: 0, pending: 0 },
  });
  await renderLoadedBudgets();
  expect(screen.queryByText('Nest Egg')).toBeNull();      // Savings row hidden
  expect(heroTotals()).toMatchObject({ spent: '$50', budget: '$100' }); // spend budget only, NOT spend + Savings target ($2,100)
});

// WHIT-574/706 — [A-hookrender] through-the-hook render: a known last_pay_date fetched via the REAL
// pay-cycle query renders a known "Next payday …" on the hero. This drives the actual hook +
// nextPayday + formatDayMonth end to end. Time is pinned (fake Date only; timers stay real so findByText polling works) so the ambient
// `new Date()` inside nextPayday is deterministic.
it('through the hook: a known last_pay_date renders a known "Next payday …"', async () => {
  pinToday(new Date('2026-09-18T10:00:00+10:00')); // 18 Sep 2026, Melbourne local day
  try {
    // last_pay_date 3 Sep, 14-day cycle, today 18 Sep → cycle started 17 Sep → next payday 1 Oct.
    // Also proves the no-leading-zero format ("1 Oct") survives a real render.
    server.seed('/paycycle', { length: 14, last_pay_date: '2026-09-03' });
    renderBudgets();
    await waitFor(() => expect(heroTotals().payday).toBe('1 Oct'));
  } finally {
    jest.useRealTimers();
  }
});

// WHIT-574/706 (moved from budgetsWrapperStates, WHIT-688) — a first payday still in the future is
// itself the next payday, and the old "Started …" line is gone.
it('through the hook: a future last_pay_date shows that date as the next payday', async () => {
  pinToday(new Date('2026-09-18T10:00:00+10:00'));
  try {
    server.seed('/paycycle', { length: 30, last_pay_date: '2026-09-25' });
    const client = makeClient();
    await renderLoadedBudgets(client);
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(payCycleReads()).toHaveLength(1);
    expect(heroTotals().payday).toBe('25 Sep');
    expect(screen.queryByText(/^Started /)).toBeNull();
  } finally {
    jest.useRealTimers();
  }
});

// ===== WHIT-188 adversarial gaps (folded in) — partial failure, empty state, auth-lock, cache
// invalidation, focus over-fetch, and the payCycle-failure dead-end. Same regime (mocked auth, fake
// server, real QueryClient); the gaps' local router mock was rewired onto the shared routerMock harness. =====

describe('partial failure', () => {
  it('budgets read fails while pay cycle succeeds → inline error + Retry (not a spinner)', async () => {
    server.fail('/budgets', 503);
    renderBudgets(makeClient());
    expect(await screen.findByTestId('budgets-error')).toBeTruthy();
    expect(screen.getByTestId('budgets-retry')).toBeTruthy();
    // WHIT-72: budgets fetches in PARALLEL now (not gated on payCycle), so it fires with the
    // DEFAULT length (14) before the cycle resolves — and the flat key means it never
    // refetches to 30. The server ignores the length anyway, so the response is still correct.
    expect(server.sent('GET', '/budgets?days=14').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('budgets-loading')).toBeNull();
  });

  it('categories read fails → inline error (rows cannot render without their category)', async () => {
    server.fail('/categories', 500);
    renderBudgets(makeClient());
    expect(await screen.findByTestId('budgets-error')).toBeTruthy();
    expect(screen.queryByText('Cafes & Coffee')).toBeNull();
  });
});

describe('empty budgets', () => {
  it('empty rollup {} → empty state (hero + Add a spending budget), not a spinner or error', async () => {
    server.seed('/budgets', {});
    renderBudgets();
    expect(await screen.findByText('Add a spending budget')).toBeTruthy();
    expect(screen.queryByTestId('budgets-loading')).toBeNull();
    expect(screen.queryByTestId('budgets-error')).toBeNull();
    expect(screen.queryByText('Cafes & Coffee')).toBeNull();
    expect(screen.getByText('days left')).toBeTruthy(); // hero still renders
  });
});

describe('focus refetch', () => {
  it('does not storm: fresh data + focus effect → each fetcher called exactly once', async () => {
    await renderLoadedBudgets(); // staleTime 60s → refetchStale is a no-op
    await act(async () => {
      await Promise.resolve();
    });
    expect(payCycleReads()).toHaveLength(1);
    expect(budgetReads()).toHaveLength(1);
    expect(categoryReads()).toHaveLength(1);
  });

  it('WHIT-713: a failed focus refresh over showing budgets shows the quiet stale line, with no pull', async () => {
    pinToday(new Date('2026-09-18T09:40:00+10:00'));
    const client = makeClient({ staleTime: 45_000 });
    // Only the screen's own focus refetch may run on return — not TanStack's refetch-on-mount.
    client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, refetchOnMount: false } });
    const first = await renderLoadedBudgets(client);
    first.unmount();

    jest.setSystemTime(new Date('2026-09-18T09:41:00+10:00'));
    server.once('GET', '/budgets', { status: 503 });
    renderBudgets(client);

    await waitFor(() => expect(budgetReads()).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId('budgets-stale')).toHaveTextContent("Couldn't refresh · showing 9:40am"));
    expect(screen.getByText('Cafes & Coffee')).toBeTruthy();
    jest.useRealTimers();
  });
});

describe('auth transition mid-session', () => {
  it('authed→locked keeps cached rows and fires no new fetch (no doomed 401 retry)', async () => {
    await renderLoadedBudgets();
    const before = budgetReads().length;

    await act(async () => {
      setAuthStatus('locked');
    });
    expect(screen.getByText('Cafes & Coffee')).toBeTruthy();
    expect(screen.queryByTestId('budgets-error')).toBeNull();
    expect(budgetReads()).toHaveLength(before);
  });
});

describe('save → cache invalidation', () => {
  it("invalidate ['budgets'] refetches the budgets query", async () => {
    // edit.tsx invalidates the module-singleton queryClient (same instance _layout mounts
    // — a static import, so identity is guaranteed). Behaviourally, invalidating ['budgets']
    // must refetch the (flat, WHIT-72) budgets query; a local client with no gcTime timer
    // proves that without leaking a background timer into the worker.
    const { client } = await renderLoadedBudgets();
    const before = budgetReads().length;

    await refreshInAct(() => client.invalidateQueries({ queryKey: ['budgets'] })); // what edit.tsx does after a save
    await waitFor(() => expect(budgetReads().length).toBeGreaterThan(before));
  });
});

// WHIT-72: budgets no longer waterfalls behind the pay cycle.
describe('parallel fetch (no waterfall)', () => {
  it('budgets fetches immediately with the default length, not gated on the pay cycle', async () => {
    // Hold the pay cycle unresolved; budgets must STILL fire (in parallel), with the default
    // length (14). On the OLD gated code fetchBudgets would not be called until payCycle
    // resolved — so this fails on revert.
    const heldPayCycle = server.hold('/paycycle');
    renderBudgets();

    await waitFor(() => expect(budgetReads().length).toBeGreaterThan(0));
    expect(server.sent('GET', '/budgets?days=14')).toHaveLength(1); // default length — cycle not yet loaded
    expect(payCycleReads()).toHaveLength(1);  // fired in parallel, still pending

    await act(async () => { heldPayCycle.release(); }); // settle to avoid an act() leak
  });
});

// WHIT-72: a pay-cycle length change refetches budgets EXACTLY once (the explicit
// invalidate), not twice. With the flat key, writing a new-length pay cycle no longer
// shifts the budgets key, so it doesn't itself trigger a refetch — only the invalidate does.
describe('length change refetches once, not twice', () => {
  it('writing a new-length pay cycle does NOT refetch; the invalidate is the single refresh', async () => {
    const { client } = await renderLoadedBudgets();
    const afterLoad = budgetReads().length;

    // persistPayCycle writes the new-length cycle into the cache. With the flat key this must
    // NOT trigger a budgets refetch on its own (the old windowed key WOULD have — refetch #1).
    await refreshInAct(() => client.setQueryData(['payCycle'], { length: 14, last_pay_date: '2026-07-01' }));
    expect(budgetReads()).toHaveLength(afterLoad); // no key-shift refetch

    // ...and the explicit invalidate persistPayCycle fires is the SINGLE refresh.
    await refreshInAct(() => client.invalidateQueries({ queryKey: ['budgets'] }));
    await waitFor(() => expect(budgetReads()).toHaveLength(afterLoad + 1));
  });
});

// A sustained payCycle failure must show the inline error + Retry, never a spinner and never
// budgets-against-a-wrong-cycle. WHIT-72: budgets now fetch in PARALLEL, so on a payCycle
// failure the rows would load (against the DEFAULT cycle) and suppress the old `isError &&
// rows.length === 0` error — the payCycleError signal restores the error here. Fail-on-revert:
// drop payCycleError from showError and this reverts to rendering rows with a wrong days-left.
describe('payCycle failure must show the error, not budgets on a wrong cycle', () => {
  it('sustained payCycle failure → inline error + Retry (payCycleError), never a spinner', async () => {
    server.fail('/paycycle', 503);
    renderBudgets(makeClient());
    expect(await screen.findByTestId('budgets-error')).toBeTruthy();
    expect(screen.getByTestId('budgets-retry')).toBeTruthy();
    expect(screen.queryByTestId('budgets-loading')).toBeNull();
  });
});

// ===== WHIT-221 (folded from budgetsSubcategory.screen.test.tsx) — same fake-server/../auth/expo-router
// regime (real QueryClient). Divergent fixtures (car/parent + parking/sub, PAY_CYCLE len 14) and the
// indent-style helpers are block-scoped here so they shadow the module coffee fixtures for these two. =====
describe('WHIT-221 parent→sub tree + de-duped hero (folded from budgetsSubcategory)', () => {
  // Car (parent) rolled-up spend 75 of 200; Parking (sub of Car) 30 of 50. Same bucket.
  const PAY_CYCLE = { length: 14, last_pay_date: '2026-07-01' };
  const CATS = [
    { id: 'car', name: 'Car', bucket: 'Living', icon: 'car', color: '#7fd1b9', parent: null },
    { id: 'parking', name: 'Parking', bucket: 'Living', icon: 'car', color: '#7fd1b9', parent: 'car' },
  ];
  const BUDGETS = {
    car: { target: 200, posted: 75, pending: 0 },
    parking: { target: 50, posted: 30, pending: 0 },
  };

  // Walk up from a text node and return the first ancestor style carrying a numeric
  // marginLeft (the depth indent block), or {} if none — the parent row has no indent block.
  function indentStyleFor(name: string): Record<string, unknown> {
    let node: any = screen.getByText(name);
    for (let i = 0; i < 8 && node; i++) {
      const st = styleOf(node);
      if (typeof st.marginLeft === 'number') return st;
      node = node.parent;
    }
    return {};
  }

  beforeEach(() => {
    seedBudgets(server, { payCycle: PAY_CYCLE, budgets: BUDGETS, categories: CATS });
  });

  it('[A26] hero de-dups: the spent line counts the parent cap once, not parent + sub', async () => {
    renderBudgets();
    expect(await screen.findByText('Car')).toBeTruthy();
    expect(screen.getByText('Parking')).toBeTruthy();      // both rows render
    expect(heroTotals()).toMatchObject({ spent: '$75', budget: '$200' }); // Car only, NOT Car + Parking
    // Reverting the `depth === 0` guard makes totBudget 250 -> Spent flips to "$105" and Budget to "$250".
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
// driven via renderHook on the REAL hooks (real ../api, ../auth mocked; NO expo-router mock originally —
// the shared module-scope expo-router mock is inert here because ../queries never imports it).
// The shared Budgets fixtures, except a coffee category with no recent spend. =====
describe('WHIT-72 payCycleError guard (folded from budgetsPayCycleError)', () => {
  const CATS = [{ ...COFFEE }];

  beforeEach(() => {
    seedBudgets(server, { categories: CATS });
  });

  describe('useBudgetsScreenData — payCycleError guard (WHIT-72)', () => {
    it('first-load payCycle failure (never-succeeded → data undefined) → payCycleError is TRUE', async () => {
      server.fail('/paycycle', 503);
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

      server.fail('/paycycle', 503);
      await act(async () => { result.current.refetch(); });
      await waitFor(() => expect(result.current.isError).toBe(true)); // the failed payCycle refetch propagates

      expect(result.current.payCycleError).toBe(false); // <-- data retained → NOT a first-load error
      expect(result.current.cycleLen).toBe(30);         // last-good cycle still drives the hero
      expect(result.current.budgets).toHaveLength(1);   // cached rows survive
    });

    it('exposes nextPayday derived from the pay cycle (WHIT-706)', async () => {
      const { result } = renderHook(() => useBudgetsScreenData(), { wrapper: wrapper(makeClient()) });
      await waitFor(() => expect(result.current.budgets).toHaveLength(1));
      // The hero reads this. It equals the pure helper on the same (len 30) cycle — proving it's
      // plumbed through, not hard-coded. Fail-on-revert: drop it from the return and this is undefined.
      expect(result.current.nextPayday).toBe(nextPayday(BUDGET_PAY_CYCLE));
      expect(result.current.nextPayday).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('BOTH payCycle AND budgets fail on first load → error via both paths (payCycleError AND isError)', async () => {
      server.fail('/paycycle', 503);
      server.fail('/budgets', 500);
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

      server.fail('/paycycle', 503);
      await act(async () => { result.current.refetch(); });
      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(result.current.payCycleError).toBe(false);
      expect(result.current.cycleLen).toBe(30);
      expect(result.current.budgets).toHaveLength(1);
    });

    it('first-load payCycle failure → payCycleError is TRUE (detail blanks on it)', async () => {
      server.fail('/paycycle', 503);
      const { result } = renderHook(() => useBudgetDetailScreenData('coffee'), { wrapper: wrapper(makeClient()) });
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.payCycleError).toBe(true);
    });
  });
});

// WHIT-573 — the hero must read "Over budget" with a signed total when spend has blown past the
// plan (totRemain < 0). fmt() strips the sign, so before the fix a negative total rendered as a
// bare positive figure under the money-left label — money overspent looked like money still left.
describe('WHIT-573 hero over-budget label + sign', () => {
  it('reads "Over budget" with a signed total when spend exceeds the plan', async () => {
    // spent 200 of available 100 → totRemain -100. Fail-on-revert: without the fix the hero says
    // "Left to spend" + unsigned "$100" — both assertions below flip.
    server.seed('/budgets', { coffee: { target: 100, posted: 200, pending: 0 } });
    await renderLoadedBudgets();
    expect(screen.getByText('Over budget')).toBeTruthy();      // label flipped
    expect(screen.getByText(`${MINUS}$100`)).toBeTruthy();            // sign now visible (fmtExact gives "$100")
    expect(screen.queryByText('Left to spend')).toBeNull(); // the misleading label is gone
  });

  it('keeps "Left to spend" (unsigned) when under the plan', async () => {
    // spent 50 of 100 → totRemain +50: the happy path must be untouched.
    server.seed('/budgets', { coffee: { target: 100, posted: 40, pending: 10 } });
    await renderLoadedBudgets();
    expect(screen.getByText('Left to spend')).toBeTruthy();
    expect(screen.queryByText('Over budget')).toBeNull();
  });

  it('reads "Left to spend" when exactly on budget (totRemain === 0), not "Over budget"', async () => {
    server.seed('/budgets', { coffee: { target: 100, posted: 100, pending: 0 } });
    await renderLoadedBudgets();
    expect(screen.getByText('Left to spend')).toBeTruthy();
    expect(screen.queryByText('Over budget')).toBeNull();
  });

  it('a sub-dollar overspend reads "Over budget −$0.30", same as the rows (WHIT-716)', async () => {
    // spent 100.30 of 100 → totRemain -0.30. With cents shown, a visible "$0.30" must never sit
    // under "Left to spend". Fail-on-revert: restore the old `< -0.5` threshold and this flips back.
    server.seed('/budgets', { coffee: { target: 100, posted: 100, pending: 0.3 } });
    await renderLoadedBudgets();
    expect(screen.getByText('Over budget')).toBeTruthy();
    expect(screen.getByText(`${MINUS}$0.30`)).toBeTruthy();
    expect(screen.queryByText('Left to spend')).toBeNull();
  });
});

// WHIT-573 — adversarial gaps beyond the cases above: aggregation across multiple over-budget rows,
// a rollover-deficit source of negativity (proves the hero total uses `available`, not target),
// Income kept out of the over-budget hero, a large signed total's exact comma-grouped string + pill
// coherence, and the 1-cent threshold boundaries (WHIT-716: 0.004 over stays calm, 0.01 over flips).
describe('WHIT-573 hero over-budget — gaps', () => {
  it('sums MULTIPLE over-budget rows into one signed hero total + coherent spent line', async () => {
    server.seed('/categories', [
      COFFEE,
      { ...GROCERIES_RECORD, color: '#7fd1b9' },
    ]);
    server.seed('/budgets', {
      coffee: { target: 100, posted: 150, pending: 0 },
      groceries: { target: 200, posted: 250, pending: 0 },
    });
    await renderLoadedBudgets();
    expect(screen.getByText('Over budget')).toBeTruthy();
    expect(screen.getByText(`${MINUS}$100`)).toBeTruthy();       // -(300 available - 400 spent)
    expect(heroTotals()).toMatchObject({ spent: '$400', budget: '$300' }); // totSpent + totBudget unchanged
    expect(screen.queryByText('Left to spend')).toBeNull();
  });

  it('negativity from a rollover DEFICIT (not raw overspend) still flips the hero, on the available envelope', async () => {
    // carryover -80 → available = 100 + (-80) = 20; spent 50 > 20 → totRemain -30. Modest raw spend,
    // but the borrowed envelope is blown — proves the hero total is built on `available`, not target.
    server.seed('/budgets', {
      coffee: { target: 100, posted: 50, pending: 0, rollover: true, carryover: -80 },
    });
    await renderLoadedBudgets();
    expect(screen.getByText('Over budget')).toBeTruthy();
    expect(screen.getByText(`${MINUS}$30`)).toBeTruthy();
    expect(heroTotals()).toMatchObject({ spent: '$50', budget: '$20' }); // available envelope, not the $100 target
  });

  it('keeps an Income budget OUT of the over-budget hero (earnings do not rescue it)', async () => {
    server.seed('/categories', [COFFEE, SALARY]);
    server.seed('/budgets', {
      coffee: { target: 100, posted: 200, pending: 0 },
      salary: { target: 5000, posted: 6000, pending: 0 },
    });
    await renderLoadedBudgets();
    expect(screen.getByText('Salary')).toBeTruthy();       // Income row still lists
    expect(screen.getByText('Over budget')).toBeTruthy();
    expect(screen.getByText(`${MINUS}$100`)).toBeTruthy();
    expect(heroTotals()).toMatchObject({ spent: '$200', budget: '$100' }); // NOT $6,200 / $5,100
  });

  it('renders a large deficit as the exact comma-grouped -$6,056 with a coherent spent line', async () => {
    server.seed('/budgets', { coffee: { target: 1000, posted: 7056, pending: 0 } });
    await renderLoadedBudgets();
    expect(screen.getByText('Over budget')).toBeTruthy();
    expect(screen.getByText(`${MINUS}$6,056`)).toBeTruthy();
    expect(heroTotals()).toMatchObject({ spent: '$7,056', budget: '$1,000' });
  });

  it('under a cent over (-0.004) stays "Left to spend" — float dust never shows "−$0"', async () => {
    server.seed('/budgets', { coffee: { target: 100, posted: 100, pending: 0.004 } });
    await renderLoadedBudgets();
    expect(screen.getByText('Left to spend')).toBeTruthy();
    expect(screen.queryByText('Over budget')).toBeNull();
  });

  it('a cent over (-0.01) flips to "Over budget −$0.01"', async () => {
    server.seed('/budgets', { coffee: { target: 100, posted: 100.01, pending: 0 } });
    await renderLoadedBudgets();
    expect(screen.getByText('Over budget')).toBeTruthy();
    expect(screen.getByText(`${MINUS}$0.01`)).toBeTruthy();
  });
});

// WHIT-713 QA — the edges the pull/stale-line acceptance tests don't reach: which of the three
// reads failed, which load time the line names, the spinner during a cold load, a pull from the
// error card, and the pay-cycle error card's reason.
describe('WHIT-713 QA: pull-to-refresh + quiet stale line edges', () => {
  beforeEach(() => { pinToday(new Date('2026-09-18T09:40:00+10:00')); });
  afterEach(() => { jest.useRealTimers(); });

  it('[A1] a failed CATEGORIES refresh (budgets fine) still shows the stale line', async () => {
    await renderLoadedBudgets();
    server.once('GET', '/categories', { status: 503 });
    await pullAndSettle();
    await waitFor(() => expect(screen.getByTestId('budgets-stale')).toHaveTextContent("Couldn't refresh · showing 9:40am"));
    expect(screen.getByText('Cafes & Coffee')).toBeTruthy();
  });

  it('[A2] a failed PAY-CYCLE refresh over a cached cycle shows the stale line, not the error card', async () => {
    await renderLoadedBudgets();
    server.once('GET', '/paycycle', 'dropped');
    await pullAndSettle();
    await waitFor(() => expect(screen.getByTestId('budgets-stale')).toHaveTextContent('You look offline · showing 9:40am'));
    expect(screen.queryByTestId('budgets-error')).toBeNull();
  });

  it('[A3] the line names the OLDEST load time: budgets refreshed at 10:05 but categories failed → 9:40am', async () => {
    await renderLoadedBudgets();
    jest.setSystemTime(new Date('2026-09-18T10:05:00+10:00'));
    server.once('GET', '/categories', { status: 503 });
    await pullAndSettle();
    await waitFor(() => expect(screen.getByTestId('budgets-stale')).toHaveTextContent("Couldn't refresh · showing 9:40am"));
  });

  it('[A4] after a good pull at 10:05, a later failed pull names 10:05am, not the first load', async () => {
    await renderLoadedBudgets();
    jest.setSystemTime(new Date('2026-09-18T10:05:00+10:00'));
    await pullAndSettle();
    expect(screen.queryByTestId('budgets-stale')).toBeNull();

    jest.setSystemTime(new Date('2026-09-18T10:30:00+10:00'));
    server.once('GET', '/budgets', { status: 503 });
    await pullAndSettle();
    await waitFor(() => expect(screen.getByTestId('budgets-stale')).toHaveTextContent("Couldn't refresh · showing 10:05am"));
  });

  it("[A5] data loaded yesterday reads with the day, so it can't pass for today", async () => {
    await renderLoadedBudgets();
    jest.setSystemTime(new Date('2026-09-19T08:00:00+10:00'));
    server.once('GET', '/budgets', { status: 503 });
    await pullAndSettle();
    await waitFor(() => expect(screen.getByTestId('budgets-stale')).toHaveTextContent("Couldn't refresh · showing 18 Sep, 9:40am"));
  });

  it('[A6] during the cold-load spinner the pull spinner stays off (no double spinner)', async () => {
    const held = server.hold('/budgets');
    renderBudgets();
    expect(await screen.findByTestId('budgets-loading')).toBeTruthy();
    act(() => { pullControl().props.onRefresh(); });
    expect(pullControl().props.refreshing).toBe(false);
    held.release();
    expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
  });

  it('[A7] pulling down on the error card recovers the budgets', async () => {
    server.once('GET', '/budgets', { status: 503 });
    renderBudgets();
    expect(await screen.findByTestId('budgets-error')).toBeTruthy();
    await pullAndSettle();
    expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
    expect(screen.queryByTestId('budgets-error')).toBeNull();
    expect(screen.queryByTestId('budgets-stale')).toBeNull();
  });

  it('[A8] a first-load PAY-CYCLE drop shows the error card with the offline reason', async () => {
    server.once('GET', '/paycycle', 'dropped');
    renderBudgets();
    expect(await screen.findByTestId('budgets-error')).toBeTruthy();
    expect(screen.getByText('You look offline. Check your connection and retry.')).toBeTruthy();
  });

  it('[A9] no stale line on a normal load', async () => {
    await renderLoadedBudgets();
    expect(screen.queryByTestId('budgets-stale')).toBeNull();
  });
});
