// WHIT-501 — the useUncategorizedCount hook itself, against a REAL QueryClient (the real ../api over
// the fake server, ../auth mocked). The wiring test (uncategorizedCountWiring) mocks this hook to lock
// the SCREENS; this file locks the hook's OWN contract that those screens depend on:
//   [B1] auth-gated: no whole-history walk fires while signed out (enabled = useIsAuthed()).
//   [B2] once authed it fetches and surfaces the RESOLVED number.
//   [B3] it returns `undefined` (not 0, not a throw) while the fetch is still in flight — the exact
//        value every consumer's `?? local` fallback and `=== 0` gate rely on.
//   [B4] the 5-minute staleTime holds: a second mount within the window serves cache, so the
//        expensive whole-history walk doesn't re-run on every screen focus.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { installFakeServer } from './support/fakeServer';

let mockAuthStatus = 'authed';
jest.mock('../auth', () => ({
  getStatus: () => mockAuthStatus,
  subscribe: () => () => {},
  getAuthToken: async () => 'test-id-token',
}));

import { useUncategorizedCount, uncategorizedCountKey } from '../queries';

const server = installFakeServer();
const COUNT_PATH = '/transactions/uncategorized/count';
const countRequests = () => server.sent('GET', COUNT_PATH);

function makeClient(staleTime = 0) {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime, gcTime: Infinity } } });
}
const wrapper = (client: QueryClient) =>
  ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

beforeEach(() => {
  mockAuthStatus = 'authed';
  server.seed(COUNT_PATH, { count: 4 });
});

// [B1] Fail-on-revert: hard-wire the query `enabled: true` (drop useIsAuthed) → the walk fires while
// anon and this fails. A 'locked' session (token read returns undefined) must be gated too.
it('does NOT fetch before login (enabled=false while anon)', () => {
  mockAuthStatus = 'anon';
  const { result } = renderHook(() => useUncategorizedCount(), { wrapper: wrapper(makeClient()) });
  expect(countRequests()).toHaveLength(0);
  expect(result.current).toBeUndefined(); // pre-auth → undefined, so consumers fall back to local
});

it('does NOT fetch while the session is locked (getStatus !== "authed")', () => {
  mockAuthStatus = 'locked';
  const { result } = renderHook(() => useUncategorizedCount(), { wrapper: wrapper(makeClient()) });
  expect(countRequests()).toHaveLength(0);
  expect(result.current).toBeUndefined(); // locked → undefined, so consumers fall back to local
});

// [B2] once authed the walk fires and the resolved number is surfaced.
it('fetches once authed and returns the RESOLVED number', async () => {
  const { result } = renderHook(() => useUncategorizedCount(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current).toBe(4));
  expect(countRequests()).toHaveLength(1);
});

// [B3] the fallback contract: while the fetch is in flight the hook is `undefined`, NEVER 0 — a
// premature 0 would flash "All caught up" over unloaded history. Fail-on-revert: give the query a
// `placeholderData: 0` / `initialData: 0` and this first assertion flips to 0.
it('is undefined (not 0) while the fetch is in flight, then resolves', async () => {
  server.seed(COUNT_PATH, { count: 0 });
  const held = server.hold(COUNT_PATH);
  const { result } = renderHook(() => useUncategorizedCount(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(countRequests()).toHaveLength(1));
  expect(result.current).toBeUndefined();      // in flight → undefined, not a premature 0
  held.release();
  await waitFor(() => expect(result.current).toBe(0)); // a RESOLVED 0 does come through (0 is real)
});

// [B4] the 5-min staleTime: a second mount on the SAME client within the window must serve cache,
// not re-run the whole-history walk. Fail-on-revert: drop the staleTime (defaults to 0) and the
// remount refetches → 2 calls. The test client's OWN default staleTime is 0, so the hook's own
// staleTime is the only thing holding the cache fresh here.
it('holds the fetched count across a remount within the 5-min staleTime (no re-walk)', async () => {
  const client = makeClient(); // default staleTime 0 → the hook's OWN 5-min staleTime is the only cache-holder
  const first = renderHook(() => useUncategorizedCount(), { wrapper: wrapper(client) });
  await waitFor(() => expect(first.result.current).toBe(4));
  expect(countRequests()).toHaveLength(1);

  const second = renderHook(() => useUncategorizedCount(), { wrapper: wrapper(client) });
  expect(second.result.current).toBe(4);                     // served straight from cache
  expect(countRequests()).toHaveLength(1); // NOT re-walked
});

// The literal key the context.tsx write sites invalidate. If this key drifts, every
// invalidateQueries({ queryKey: ['uncategorizedCount'] }) silently misses this cache.
it('uncategorizedCountKey is the exact literal the write sites invalidate', () => {
  expect(uncategorizedCountKey).toEqual(['uncategorizedCount']);
});
