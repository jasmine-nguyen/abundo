// WHIT-696 QA — the shared settle() / loaded() waits really wait: every touched suite now trusts them
// to hold back its assertions until the reads land, so a wait that returns early would silently weaken
// ~25 suites at once.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
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
import { useTestQueryClient, WithQueries, settle, loaded, refreshInAct } from './support/renderWithQueries';

const server = installFakeServer();
useTestQueryClient();
beforeEach(() => resetAuth());

function CategoryNames() {
  const { categories } = useCategories();
  return <Text>{categories.map((category) => category.name).join(',') || 'none'}</Text>;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 100));

describe('shared query waits (QA)', () => {
  // [A1] settle() must not return while a read is still in flight.
  it('settle() keeps waiting while a read is held, and returns once it lands', async () => {
    server.seed('/categories', [ESSENTIAL_GROCERIES_TOP]);
    const held = server.hold('/categories');
    render(<WithQueries><CategoryNames /></WithQueries>);

    let done = false;
    const waiting = settle().then(() => { done = true; });
    await tick();
    expect(done).toBe(false);
    expect(queryClient.isFetching()).toBeGreaterThan(0);

    await refreshInAct(() => held.release());
    await waiting;
    expect(done).toBe(true);
    expect(queryClient.isFetching()).toEqual(0);
    expect(await screen.findByText('Groceries')).toBeTruthy();
  });

  // [A2] loaded(key) must not return while that query is still loading.
  it('loaded(key) keeps waiting while that query is held, and returns once it succeeds', async () => {
    server.seed('/categories', [ESSENTIAL_GROCERIES_TOP]);
    const held = server.hold('/categories');
    render(<WithQueries><CategoryNames /></WithQueries>);

    let done = false;
    const waiting = loaded(categoriesKey).then(() => { done = true; });
    await tick();
    expect(done).toBe(false);

    await refreshInAct(() => held.release());
    await waiting;
    expect(queryClient.getQueryState(categoriesKey)?.status).toBe('success');
    await settle();
  });

  // [A3] loaded(key) means "loaded OK" — a failed read must not count as loaded.
  it('loaded(key) does not accept a failed read', async () => {
    server.fail('/categories', 500, 'boom');
    render(<WithQueries><CategoryNames /></WithQueries>);
    await settle();
    expect(queryClient.getQueryState(categoriesKey)?.status).toBe('error');

    await expect(loaded(categoriesKey)).rejects.toBeTruthy();
  });
});
