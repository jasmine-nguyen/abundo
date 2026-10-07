// WHIT-641 — draw a screen under the real query provider, over the app's `queryClient` singleton
// (the one context.tsx's writers use, so hooks and writers share one cache). Call
// useTestQueryClient() at file scope: no retries, and a cleared cache between tests.
// (Not a *.test file, so the jest testMatch never runs it as a suite.)
import React from 'react';
import { beforeEach, afterEach, expect, jest } from '@jest/globals';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, waitFor } from '@testing-library/react-native';
import { queryClient } from '../../queryClient';

export function useTestQueryClient() {
  beforeEach(() => {
    queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retry: false } });
  });
  afterEach(() => queryClient.clear());
}

export function WithQueries({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

// Mirrors @testing-library/react-native's check: legacy fake timers mark setTimeout as a mock,
// modern ones hang a `clock` on it.
function fakeTimersOn() {
  return (setTimeout as any)._isMockFunction === true || Object.prototype.hasOwnProperty.call(setTimeout, 'clock');
}

/**
 * Run a cache refresh or write (invalidate/refetch/setQueryData/remove…) inside act, then flush one
 * tick so the query library's batched notifications (one setTimeout(0) flush) re-render inside act
 * too. On a fake clock the tick is advanced by hand, in its own sync act: advancing inside an async
 * act also runs React's faked "was this act awaited?" check too early. Otherwise it yields a real
 * macrotask. Without
 * it the re-render lands after act, React logs an act warning, and under coverage that log alone
 * can stall the test past waitFor's 1s timeout.
 */
export async function refreshInAct(refresh: () => unknown) {
  if (fakeTimersOn()) {
    await act(async () => {
      await refresh();
    });
    act(() => {
      jest.advanceTimersByTime(0);
    });
    return;
  }
  await act(async () => {
    await refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Wait until no query is fetching. */
export const settle = () => waitFor(() => expect(queryClient.isFetching()).toBe(0));

/** Wait until one query has loaded. */
export const loaded = (queryKey: readonly unknown[]) =>
  waitFor(() => expect(queryClient.getQueryState(queryKey)?.status).toBe('success'));

/** Render inside WithQueries, wait until the first reads have settled, then flush their redraw. */
export async function renderWithQueries(ui: React.ReactElement) {
  const view = render(<WithQueries>{ui}</WithQueries>);
  await settle();
  await refreshInAct(() => undefined);
  return view;
}

/** Draw inside WithQueries without waiting, for a held (still-loading) reply. */
export function drawHeld(ui: React.ReactElement) {
  return render(<WithQueries>{ui}</WithQueries>);
}

/** Let a held reply go and wait for it to land and redraw, so nothing runs into the next test. */
export async function releaseAndSettle(held: { release: () => void }) {
  await act(async () => { held.release(); });
  await settle();
  await refreshInAct(() => undefined);
}

/**
 * Load the screen's data, then remount it over the warm cache — the way the app usually opens a
 * screen whose data was already fetched elsewhere (e.g. the Loan form after the Home loan screen).
 * `Wrapper` must include WithQueries (support/renderWithApp's WithApp does).
 */
export async function renderLoaded(ui: React.ReactElement, Wrapper: React.ComponentType<{ children: React.ReactNode }> = WithQueries) {
  const view = render(<Wrapper><React.Fragment key="loading">{ui}</React.Fragment></Wrapper>);
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  await act(async () => {
    view.rerender(<Wrapper><React.Fragment key="loaded">{ui}</React.Fragment></Wrapper>);
  });
  await settle();
  await refreshInAct(() => undefined);
  return view;
}
