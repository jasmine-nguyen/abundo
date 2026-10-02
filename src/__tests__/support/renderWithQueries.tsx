// WHIT-641 — draw a screen under the real query provider, over the app's `queryClient` singleton
// (the one context.tsx's writers use, so hooks and writers share one cache). Call
// useTestQueryClient() at file scope: no retries, and a cleared cache between tests.
// (Not a *.test file, so the jest testMatch never runs it as a suite.)
import React from 'react';
import { beforeEach, afterEach, expect } from '@jest/globals';
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

/**
 * Run a cache refresh or write (invalidate/refetch/setQueryData/remove…) inside act, then yield one
 * macrotask so the query library's batched notifications (one setTimeout(0) flush) re-render inside
 * act too. Without the yield the re-render lands after act, React logs an act warning, and under
 * coverage that log alone can stall the test past waitFor's 1s timeout.
 */
export async function refreshInAct(refresh: () => unknown) {
  await act(async () => {
    await refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Render inside WithQueries and wait until the first reads have settled. */
export async function renderWithQueries(ui: React.ReactElement) {
  const view = render(<WithQueries>{ui}</WithQueries>);
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  return view;
}

/**
 * Load the screen's data, then remount it over the warm cache — the way the app opens a form that
 * fills its fields once on first draw (the Loan form, app/loan.tsx) after the data has loaded.
 * `Wrapper` must include WithQueries (support/renderWithApp's WithApp does).
 */
export async function renderLoaded(ui: React.ReactElement, Wrapper: React.ComponentType<{ children: React.ReactNode }> = WithQueries) {
  const view = render(<Wrapper><React.Fragment key="loading">{ui}</React.Fragment></Wrapper>);
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  await act(async () => {
    view.rerender(<Wrapper><React.Fragment key="loaded">{ui}</React.Fragment></Wrapper>);
  });
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  return view;
}
