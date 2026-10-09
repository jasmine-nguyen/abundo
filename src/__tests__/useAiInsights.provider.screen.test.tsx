// WHIT-833 — the Insights AI card reads its summary, runs "Analyse my spending" and shows its
// spinner / retry state from useAiInsights(), over the shared query cache, not the AppProvider store.
// Drawn inside the real AppProvider under the app's queryClient, against the fake server.
import { it, expect, jest, beforeEach } from '@jest/globals';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { useAiInsights } from '../hooks/useAiInsights';
import { queryClient } from '../queryClient';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { resetAuth, setAuthStatus } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { refreshInAct, settle, useTestQueryClient } from './support/renderWithQueries';
import { queriesAppWrapper as wrapper } from './support/renderWithApp';

const server = installFakeServer();
useTestQueryClient();

const insights = (summary: string | null) => ({
  summary, suggestions: [], generated_at: null, cycle_start: null, cached: false,
});
const GOAL = { payoff_mode: 'ahead', mortgage_free_date: 'Nov 2042', current_extra_monthly: 200, months_sooner_per_100_extra: 7 } as const;

beforeEach(() => { resetAuth(); });

it('user sees the saved summary, can generate a new one (with spinner) and retry a failed one, and refresh keeps data on failure', async () => {
  server.seed('/insights/ai', insights('saved summary'));
  const { result } = renderHook(() => useAiInsights(), { wrapper });

  await waitFor(() => expect(result.current.insights?.summary).toBe('saved summary'));
  expect(result.current.isLoading).toBe(false);
  expect(result.current.isError).toBe(false);

  // A failed generate arms the retry state and keeps the summary already on screen.
  server.once('POST', '/insights/ai', { status: 502 });
  await act(async () => { await result.current.generate(null); });
  // The query library redraws one tick after the request settles.
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.isLoading).toBe(false);
  expect(result.current.insights?.summary).toBe('saved summary');

  // Retry: the spinner shows while the paid call runs, then the new summary replaces the old one.
  const held = server.hold('/insights/ai');
  server.once('POST', '/insights/ai', { body: insights('fresh summary') });
  let pending!: Promise<unknown>;
  act(() => { pending = result.current.generate(GOAL); });
  await waitFor(() => expect(result.current.isLoading).toBe(true));
  expect(result.current.isError).toBe(false);
  await act(async () => { held.release(); await pending; });
  await waitFor(() => expect(result.current.insights?.summary).toBe('fresh summary'));
  expect(result.current.isLoading).toBe(false);
  expect(result.current.isError).toBe(false);
  expect(server.sent('POST', '/insights/ai').map((request) => request.body)).toEqual([{ goal: null }, { goal: GOAL }]);

  // A failed refresh is silent: no retry state, the summary stays.
  server.once('GET', '/insights/ai', { status: 500 });
  await act(async () => { await result.current.refresh(); });
  expect(result.current.isError).toBe(false);
  expect(result.current.insights?.summary).toBe('fresh summary');

  // A working refresh reads the server's saved summary.
  server.seed('/insights/ai', insights('refreshed summary'));
  await act(async () => { await result.current.refresh(); });
  await waitFor(() => expect(result.current.insights?.summary).toBe('refreshed summary'));
});

it('sign-out clears the summary and spinner, and a generate answering after re-sign-in is thrown away', async () => {
  server.seed('/insights/ai', insights('old account summary'));
  const { result } = renderHook(() => useAiInsights(), { wrapper });
  await waitFor(() => expect(result.current.insights?.summary).toBe('old account summary'));

  const held = server.hold('/insights/ai');
  server.once('POST', '/insights/ai', { body: insights('late old account summary') });
  let pending!: Promise<unknown>;
  act(() => { pending = result.current.generate(null); });
  await waitFor(() => expect(server.sent('POST', '/insights/ai')).toHaveLength(1));
  await waitFor(() => expect(result.current.isLoading).toBe(true));

  // Sign-out, as auth.ts does it: wipe the query cache, then move to 'anon'.
  act(() => { queryClient.clear(); setAuthStatus('anon'); });
  await waitFor(() => expect(result.current.insights).toBeNull());
  expect(result.current.isLoading).toBe(false);
  expect(result.current.isError).toBe(false);

  // A new account signs in before the old generate answers.
  server.seed('/insights/ai', insights(null));
  act(() => { setAuthStatus('authed'); });
  await act(async () => { held.release(); await pending; });
  await settle();

  expect(result.current.insights?.summary ?? null).toBeNull();
  expect(result.current.isLoading).toBe(false);
  expect(result.current.isError).toBe(false);
});

it("a stale generate failing after re-sign-in neither stops the new session's spinner nor shows an error", async () => {
  server.seed('/insights/ai', insights(null));
  const { result } = renderHook(() => useAiInsights(), { wrapper });
  const heldA = server.hold('/insights/ai');
  let pendingA!: Promise<unknown>;
  act(() => { pendingA = result.current.generate(null); });
  await waitFor(() => expect(server.sent('POST', '/insights/ai')).toHaveLength(1));

  act(() => { queryClient.clear(); setAuthStatus('anon'); });
  act(() => { setAuthStatus('authed'); });
  const heldB = server.hold('/insights/ai');
  act(() => { void result.current.generate(null); });
  await waitFor(() => expect(server.sent('POST', '/insights/ai')).toHaveLength(2));
  await waitFor(() => expect(result.current.isLoading).toBe(true));

  await refreshInAct(async () => { heldA.fail('POST'); await pendingA; });

  expect(result.current.isLoading).toBe(true);
  expect(result.current.isError).toBe(false);
  await act(async () => { heldB.release(); });
});

it('a generate settling during a Face ID lock (same session) is kept', async () => {
  server.seed('/insights/ai', insights(null));
  const { result } = renderHook(() => useAiInsights(), { wrapper });
  const held = server.hold('/insights/ai');
  server.once('POST', '/insights/ai', { body: insights('my insights') });
  let pending!: Promise<unknown>;
  act(() => { pending = result.current.generate(null); });
  await waitFor(() => expect(server.sent('POST', '/insights/ai')).toHaveLength(1));

  act(() => { setAuthStatus('locked'); });
  await act(async () => { held.release(); await pending; });
  act(() => { setAuthStatus('authed'); });

  await waitFor(() => expect(result.current.insights?.summary).toBe('my insights'));
});
