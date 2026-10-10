// WHIT-188 — the Budgets screen on the new query layer. Proves the behaviours that
// matter: data comes from the auth-gated queries, a transient 5xx self-heals (no stuck
// banner), a sustained failure shows an inline retry, and nothing fetches before login.
// Real ../api over the fake server; ../auth + expo-router mocked; the screen renders under a
// real QueryClientProvider so the actual query behaviour runs.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { screen, fireEvent, act, waitFor, renderHook } from '@testing-library/react-native';
import { makeClient, wrapper, pause } from './support/queryClient';
import { BUDGETS, seedBudgets, renderBudgets, renderLoadedBudgets, heroTotals } from './support/budgetsScreen';
import { routerSpies, resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { pinToday } from './support/clock';
import { pullControl, pullAndSettle } from './support/pull';

// auth: controllable status + a real subscribe, so the "fires on login" test can flip it.
jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { setAuthStatus, setAuthStatusQuietly, resetAuth } from './support/authMock';

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

// The REAL query hooks (real ../api over the fake server, ../auth mocked above) — driven directly
// by the WHIT-72 tests via renderHook; the same regime the screen renders under.
import { useBudgetsScreenData, useBudgetDetailScreenData } from '../queries';
import { COFFEE } from './support/categories';
import { MINUS } from '../theme';

const server = installFakeServer();
// The Budgets reads. The exact `/budgets` path counts the rollup read only, never a budget's
// own transactions list.
const budgetReads = () => server.sent('GET', '/budgets');
const payCycleReads = () => server.sent('GET', '/paycycle');
const categoryReads = () => server.sent('GET', '/categories');

beforeEach(() => {
  resetAuth();
  // The shared pay cycle has length 30 (NOT the default 14).
  seedBudgets(server);
  resetRouter();
});

it('renders budget rows from the queries, fetched in parallel with the pay cycle', async () => {
  await renderLoadedBudgets();
  // WHIT-72: budgets fetch in PARALLEL now (flat key, no gate), so they fire with the default
  // length (14) before the cycle resolves — and never refetch to 30. The server ignores the
  // length anyway (it derives the window itself), so the rendered rows are still correct.
  expect(budgetReads()).toHaveLength(1);
  expect(payCycleReads()).toHaveLength(1);
  expect(categoryReads()).toHaveLength(1);
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

  // WHIT-198: the Retry routes through the shared RetryButton, so it carries the button role +
  // a screen-reader label (which the old bare Pressable lacked).
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

// WHIT-574/706 — a known last_pay_date fetched via the REAL pay-cycle query renders a known
// "Next payday …" on the hero. Time is pinned (fake Date only; timers stay real so findByText
// polling works) so the ambient `new Date()` inside nextPayday is deterministic.
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

it('categories read fails → inline error (rows cannot render without their category)', async () => {
  server.fail('/categories', 500);
  renderBudgets(makeClient());
  expect(await screen.findByTestId('budgets-error')).toBeTruthy();
  expect(screen.queryByText('Cafes & Coffee')).toBeNull();
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

// A sustained payCycle failure must show the inline error + Retry, never a spinner and never
// budgets-against-a-wrong-cycle. WHIT-72: budgets fetch in PARALLEL, so on a payCycle failure the
// rows would load (against the DEFAULT cycle); the payCycleError signal restores the error here.
it('sustained payCycle failure → inline error + Retry (payCycleError), never a spinner', async () => {
  server.fail('/paycycle', 503);
  renderBudgets(makeClient());
  expect(await screen.findByTestId('budgets-error')).toBeTruthy();
  expect(screen.getByTestId('budgets-retry')).toBeTruthy();
  expect(screen.queryByTestId('budgets-loading')).toBeNull();
});

// WHIT-72 — a BACKGROUND pay-cycle refetch failure keeps the last-good cycle and the cached rows
// (cache-first). TanStack v5 retains the last-good data, so data!==undefined ⇒ payCycleError must
// stay FALSE. A bare `.isError` (no data guard) would flip it true and blank cached budgets.
describe('WHIT-72 payCycleError guard', () => {
  beforeEach(() => {
    seedBudgets(server, { categories: [{ ...COFFEE }] });
  });

  it('BACKGROUND payCycle refetch failure over a cached cycle → payCycleError stays FALSE, rows + last-good cycle survive (cache-first)', async () => {
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
});

// WHIT-573 — the hero must read "Over budget" with a signed total when spend has blown past the
// plan (totRemain < 0). fmt() strips the sign, so before the fix a negative total rendered as a
// bare positive figure under the money-left label — money overspent looked like money still left.
describe('WHIT-573 hero over-budget label + sign', () => {
  it('reads "Over budget" with a signed total when spend exceeds the plan', async () => {
    // spent 200 of available 100 → totRemain -100.
    server.seed('/budgets', { coffee: { target: 100, posted: 200, pending: 0 } });
    await renderLoadedBudgets();
    expect(screen.getByText('Over budget')).toBeTruthy();      // label flipped
    expect(screen.getByText(`${MINUS}$100`)).toBeTruthy();     // sign visible
    expect(screen.queryByText('Left to spend')).toBeNull();    // the misleading label is gone
  });

  // The 1-cent threshold (WHIT-716): with cents shown, a visible "$0.30" must never sit under
  // "Left to spend", and float dust never shows "−$0".
  it.each([
    ['exactly on budget (totRemain === 0) reads "Left to spend", not "Over budget"', 100, 0, 'Left to spend', 'Over budget', null],
    ['a sub-dollar overspend reads "Over budget −$0.30", same as the rows', 100, 0.3, 'Over budget', 'Left to spend', `${MINUS}$0.30`],
    ['under a cent over (-0.004) stays "Left to spend"', 100, 0.004, 'Left to spend', 'Over budget', null],
    ['a cent over (-0.01) flips to "Over budget −$0.01"', 100.01, 0, 'Over budget', 'Left to spend', `${MINUS}$0.01`],
  ])('%s', async (_case, posted, pending, shown, hidden, signed) => {
    server.seed('/budgets', { coffee: { target: 100, posted, pending } });
    await renderLoadedBudgets();
    expect(screen.getByText(shown)).toBeTruthy();
    expect(screen.queryByText(hidden)).toBeNull();
    if (signed) expect(screen.getByText(signed)).toBeTruthy();
  });
});

// WHIT-713 — pull down to refresh, and the quiet "couldn't refresh" line. The clock is pinned to
// 9:40am Melbourne so the line's "showing <time>" is a known literal.
describe('WHIT-713 pull-to-refresh + quiet stale line', () => {
  beforeEach(() => { pinToday(new Date('2026-09-18T09:40:00+10:00')); });
  afterEach(() => { jest.useRealTimers(); });

  it('user can pull down on Budgets to refetch, and the pull spinner clears', async () => {
    await renderLoadedBudgets();
    expect(budgetReads()).toHaveLength(1);

    const held = server.hold('/budgets');
    act(() => { pullControl().props.onRefresh(); });
    await waitFor(() => expect(budgetReads()).toHaveLength(2));
    expect(pullControl().props.refreshing).toBe(true);

    held.release();
    await waitFor(() => expect(pullControl().props.refreshing).toBe(false));
    expect(screen.getByText('Cafes & Coffee')).toBeTruthy();
  });

  it('a failed refresh over showing budgets keeps the rows and says "Couldn\'t refresh · showing <time>", cleared by a good pull', async () => {
    await renderLoadedBudgets();
    expect(screen.queryByTestId('budgets-stale')).toBeNull();

    server.once('GET', '/budgets', { status: 503 });
    await pullAndSettle();

    await waitFor(() => expect(screen.getByTestId('budgets-stale')).toBeTruthy());
    expect(screen.getByTestId('budgets-stale')).toHaveTextContent("Couldn't refresh · showing 9:40am");
    expect(screen.getByText('Cafes & Coffee')).toBeTruthy();
    expect(screen.queryByTestId('budgets-error')).toBeNull();

    await pullAndSettle();
    await waitFor(() => expect(screen.queryByTestId('budgets-stale')).toBeNull());
    expect(screen.getByText('Cafes & Coffee')).toBeTruthy();
  });

  it('[A2] a failed PAY-CYCLE refresh over a cached cycle shows the stale line, not the error card', async () => {
    await renderLoadedBudgets();
    server.once('GET', '/paycycle', 'dropped');
    await pullAndSettle();
    await waitFor(() => expect(screen.getByTestId('budgets-stale')).toHaveTextContent('You look offline · showing 9:40am'));
    expect(screen.queryByTestId('budgets-error')).toBeNull();
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
});
