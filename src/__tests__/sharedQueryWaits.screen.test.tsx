// WHIT-696 — the "wait until nothing is loading" / "wait until one query has loaded" steps live once,
// in support/renderWithQueries, and the screen suites import them instead of keeping copies.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import path from 'path';
import React from 'react';
import { Text } from 'react-native';
import { render, screen } from '@testing-library/react-native';

jest.mock('../auth', () => require('./support/authMock').authMockModule());

import { queryClient } from '../queryClient';
import { useCategories } from '../queries';
import { categoriesKey } from '../queryKeys';
import { installFakeServer } from './support/fakeServer';
import { ESSENTIAL_GROCERIES_TOP } from './support/categories';
import { resetAuth } from './support/authMock';
import * as support from './support/renderWithQueries';
import { findOffenders } from './support/sourceScan';

const server = installFakeServer();
support.useTestQueryClient();
beforeEach(() => resetAuth());

function CategoryNames() {
  const { categories } = useCategories();
  return <Text>{categories.map((category) => category.name).join(',') || 'none'}</Text>;
}

describe('shared query waits', () => {
  it('a suite can wait for its reads to settle and for one query to load via the shared helpers', async () => {
    const { settle, loaded, WithQueries } = support as any;
    expect(typeof settle).toBe('function');
    expect(typeof loaded).toBe('function');

    server.seed('/categories', [ESSENTIAL_GROCERIES_TOP]);
    render(<WithQueries><CategoryNames /></WithQueries>);

    await loaded(categoriesKey);
    expect(queryClient.getQueryState(categoriesKey)?.status).toBe('success');

    await settle();
    expect(queryClient.isFetching()).toBe(0);
    expect(await screen.findByText('Groceries')).toBeTruthy();
  });

  it('no screen suite keeps its own copy of the "nothing is fetching" wait', () => {
    const needle = ['isFetching', '()).toBe(0)'].join('');
    const allowed = new Set([
      'support/renderWithQueries.tsx',
      'budgetsQuery.screen.test.tsx', // waits on its own separate client
      path.basename(__filename),
    ]);

    expect(findOffenders((line) => line.includes(needle), allowed)).toEqual([]);
  });
});
