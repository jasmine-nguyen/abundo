// WHIT-641 QA — the shared query setup (support/renderWithQueries) the whole-app suites and the
// follow-up cards stand on: one app cache, no retries, a clean cache per test, and a render that
// returns only once the first reads have landed.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { Text } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { useQueryClient } from '@tanstack/react-query';

jest.mock('../auth', () => require('./support/authMock').authMockModule());

import { queryClient } from '../queryClient';
import { categoriesKey, useCategories } from '../queries';
import { installFakeServer } from './support/fakeServer';
import { GROCERIES_RECORD } from './support/categories';
import { resetAuth } from './support/authMock';
import { useTestQueryClient, WithQueries, renderWithQueries } from './support/renderWithQueries';

const server = installFakeServer();
useTestQueryClient();
beforeEach(() => resetAuth());

function CategoryNames() {
  const { categories, isError } = useCategories();
  if (isError) return <Text>load failed</Text>;
  return <Text>{categories.map((category) => category.name).join(',') || 'none'}</Text>;
}

describe('renderWithQueries', () => {
  // [A1] hooks and context.tsx's writers must share one cache — the app singleton.
  it('provides the app queryClient singleton, not a fresh client', async () => {
    let seen: unknown;
    function Grab() { seen = useQueryClient(); return null; }
    await renderWithQueries(<Grab />);
    expect(seen).toBe(queryClient);
  });

  // [A4] callers assert synchronously after the await — the seeded read must already be drawn.
  it('returns only after the first reads have landed', async () => {
    server.seed('/categories', [GROCERIES_RECORD]);
    await renderWithQueries(<CategoryNames />);
    expect(queryClient.isFetching()).toBe(0);
    expect(screen.getByText('Groceries')).toBeTruthy();
  });

  // [A2] retries off: a failed read settles to its error at once, after exactly one request.
  it('turns retries off — a failing read errors after one request', async () => {
    server.fail('/categories', 500, 'boom');
    await renderWithQueries(<CategoryNames />);
    expect(screen.getByText('load failed')).toBeTruthy();
    expect(server.sent('GET', '/categories')).toHaveLength(1);
  });

  // [A5] only `retry` changes — the app's other read defaults stay as makeQueryClient set them.
  it('keeps the app client\'s other query defaults', () => {
    const defaults = queryClient.getDefaultOptions().queries;
    expect(defaults?.retry).toBe(false);
    expect(defaults?.staleTime).toBe(45_000);
    expect(defaults?.gcTime).toBe(5 * 60_000);
    expect(defaults?.refetchOnReconnect).toBe(true);
  });

  // [A6] WithQueries alone draws without waiting (for tests that hold a read or start signed out).
  it('WithQueries draws immediately, before the read lands', () => {
    server.seed('/categories', [GROCERIES_RECORD]);
    const view = render(<WithQueries><CategoryNames /></WithQueries>);
    expect(screen.getByText('none')).toBeTruthy();
    view.unmount();
  });
});

// [A3] the cache is cleared between tests — two tests in order, the second sees nothing cached.
describe('useTestQueryClient clears the cache between tests', () => {
  it('first test fills the categories cache', async () => {
    server.seed('/categories', [GROCERIES_RECORD]);
    await renderWithQueries(<CategoryNames />);
    expect(queryClient.getQueryData(categoriesKey)).toEqual([GROCERIES_RECORD]);
  });

  it('second test starts with an empty cache', () => {
    expect(queryClient.getQueryData(categoriesKey)).toBeUndefined();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });
});
