// WHIT-674 QA — the shared test client's defaults are what ~30 converted screen tests silently rely on
// (bare makeClient() used to mean staleTime 60_000, retry false, gcTime Infinity in every copy).
import { describe, it, expect } from '@jest/globals';
import { useQuery } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react-native';
import { makeClient, wrapper, pause } from './support/queryClient';

describe('support/queryClient makeClient', () => {
  // [A1]
  it('bare makeClient() keeps data fresh for 60s, never retries and never garbage-collects', () => {
    const queries = makeClient().getDefaultOptions().queries;
    expect(queries?.staleTime).toBe(60_000);
    expect(queries?.retry).toBe(false);
    expect(queries?.gcTime).toBe(Infinity);
  });

  // [A2]
  it('named options override only the setting given', () => {
    const stale = makeClient({ staleTime: 0 }).getDefaultOptions().queries;
    expect(stale?.staleTime).toBe(0);
    expect(stale?.retry).toBe(false);
    const retrying = makeClient({ retry: 2 }).getDefaultOptions().queries;
    expect(retrying?.retry).toBe(2);
    expect(retrying?.staleTime).toBe(60_000);
    expect(retrying?.retryDelay).toBe(1);
  });

  // [A3]
  it('each call is a fresh client with an empty cache', () => {
    const first = makeClient();
    first.setQueryData(['k'], 1);
    expect(makeClient().getQueryData(['k'])).toBeUndefined();
  });

  // [A4]
  it('wrapper provides the given client to hooks, and retry: 2 retries a failing query twice', async () => {
    const client = makeClient({ retry: 2 });
    let calls = 0;
    const { result } = renderHook(
      () => useQuery({ queryKey: ['boom'], queryFn: async () => { calls += 1; throw new Error('boom'); } }),
      { wrapper: wrapper(client) },
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(calls).toBe(3);
    expect(client.getQueryCache().find({ queryKey: ['boom'] })).toBeDefined();
  });

  // [A5]
  it('pause waits at least the given time', async () => {
    const start = Date.now();
    await pause(50);
    expect(Date.now() - start).toBeGreaterThanOrEqual(45);
  });
});
