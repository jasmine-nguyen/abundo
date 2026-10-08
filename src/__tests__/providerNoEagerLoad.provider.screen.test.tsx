// WHIT-192 — the teardown's core guarantee: AppProvider no longer eager-loads server data
// on mount (the eager store is gone; every screen reads the auth-gated query layer on
// demand). Locks it: mounting the provider fires ZERO server reads and populates no
// server-data cache itself. Fail-on-revert: re-add any eager mount fetch (or the auth-reload
// effect) and an assertion here breaks. The per-query "not fetched before login, fires on
// auth flip" behaviour that this used to cover on the store now lives in the *Query tests
// (transactionsQuery / budgetsQuery / settingsQuery / goalScreenData / rulesScreenData).
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { renderHook, act } from '@testing-library/react-native';
import { useAppContext } from '../context';
import { queryClient } from '../queryClient';

// Pin 'authed' so a (hypothetical, reverted) auth-reload effect would fire if it still
// existed — making this a real fail-on-revert guard, not one masked by a signed-out gate.
jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { installFakeServer } from './support/fakeServer';
import { appProviderWrapper as wrapper } from './support/renderWithApp';

const server = installFakeServer();

beforeEach(() => { queryClient.clear(); });
afterEach(() => { queryClient.clear(); });

it('does not eager-fetch any server data on mount (the query layer loads on demand)', async () => {
  const { result } = renderHook(() => useAppContext(), { wrapper });
  // A real request reaches the server a few async steps after it starts (sign-in token → fetch).
  await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });

  // The provider mounted (its actions are live)…
  expect(result.current.saveLoanFacts).toBeDefined();

  // …but not one server read fired — there's no eager store to fill.
  expect(server.requests()).toEqual([]);

  // …and the provider populated no server-data cache of its own.
  expect(queryClient.getQueryData(['transactions'])).toBeUndefined();
  expect(queryClient.getQueryData(['categories'])).toBeUndefined();
});
