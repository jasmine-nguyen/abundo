// WHIT-696 — the "wait until nothing is loading" / "wait until one query has loaded" steps live once,
// in support/renderWithQueries, and the screen suites import them instead of keeping copies.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import React from 'react';
import { Text } from 'react-native';
import { render, screen } from '@testing-library/react-native';

jest.mock('../auth', () => require('./support/authMock').authMockModule());

import { queryClient } from '../queryClient';
import { useCategories } from '../queries';
import { categoriesKey } from '../queryKeys';
import { installFakeServer } from './support/fakeServer';
import { resetAuth } from './support/authMock';
import * as support from './support/renderWithQueries';

const server = installFakeServer();
support.useTestQueryClient();
beforeEach(() => resetAuth());

const GROCERIES = { id: 'groceries', name: 'Groceries', icon: 'cart', bucket: 'Essentials', recent: 0, parent: null };

function CategoryNames() {
  const { categories } = useCategories();
  return <Text>{categories.map((category) => category.name).join(',') || 'none'}</Text>;
}

describe('shared query waits', () => {
  it('a suite can wait for its reads to settle and for one query to load via the shared helpers', async () => {
    const { settle, loaded, WithQueries } = support as any;
    expect(typeof settle).toBe('function');
    expect(typeof loaded).toBe('function');

    server.seed('/categories', [GROCERIES]);
    render(<WithQueries><CategoryNames /></WithQueries>);

    await loaded(categoriesKey);
    expect(queryClient.getQueryState(categoriesKey)?.status).toBe('success');

    await settle();
    expect(queryClient.isFetching()).toBe(0);
    expect(await screen.findByText('Groceries')).toBeTruthy();
  });

  it('no screen suite keeps its own copy of the "nothing is fetching" wait', () => {
    const testsDir = path.join(__dirname);
    const needle = ['isFetching', '()).toBe(0)'].join('');
    const allowed = new Set([
      path.join('support', 'renderWithQueries.tsx'),
      'budgetsQuery.screen.test.tsx', // waits on its own separate client
      'renderWithQueries.screen.test.tsx', // a plain assertion, not a wait
      path.basename(__filename),
    ]);

    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        const relative = path.relative(testsDir, full);
        if (allowed.has(relative)) continue;
        const source = fs.readFileSync(full, 'utf8');
        source.split('\n').forEach((line, index) => {
          if (line.includes(needle)) offenders.push(`${relative}:${index + 1}`);
        });
      }
    };
    walk(testsDir);

    expect(offenders).toEqual([]);
  });
});
