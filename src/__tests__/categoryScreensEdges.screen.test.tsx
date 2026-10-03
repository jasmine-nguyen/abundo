// WHIT-688 slice 3 QA — edge cases only reachable now that the category drill-in and the category
// edit screen read through the real query hooks over the fake server: the Uncategorized drill,
// Retry recovering after a failure, a cycle switch re-reading under its own cache key, an edit
// screen whose taxonomy FAILED (not just loading), and a background re-read not wiping typing.
// The screens draw inside the real AppProvider (WHIT-692), so Save runs the real saveCategory and
// the fake server's request log shows what it sent.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { screen, fireEvent, waitFor } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient, renderLoaded, refreshInAct } from './support/renderWithQueries';
import { renderWithApp, WithApp, resetAppProbe } from './support/renderWithApp';
import { resetAuth } from './support/authMock';
import { setParams, resetRouter } from './support/routerMock';
import { queryClient } from '../queryClient';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import CategoryDetail from '../../app/category/[id]';
import CategoryEdit from '../../app/category/edit';
import { COFFEE_RECORD } from './support/categories';

const server = installFakeServer();
useTestQueryClient();

const COFFEE_ROWS = '/categories/coffee/transactions';
const CATEGORIES = [{ ...COFFEE_RECORD, parent: null }];
const ROW = {
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'ST ALi', merchant_name: 'ST Ali', amount: -8.5, account_id: 'a1',
  account_name: 'Everyday', category: 'coffee', status: 'posted', type: 'purchase', counts_to_budget: true,
};

const categoryPatches = () => server.sentUnder('PATCH', '/categories');

beforeEach(() => {
  resetAuth();
  resetRouter();
  resetAppProbe();
  server.seed('/categories', CATEGORIES);
});

describe('category drill-in edges', () => {
  beforeEach(() => {
    setParams({ id: 'coffee', cycle: '0' });
    server.seed(COFFEE_ROWS, [ROW]);
  });

  // [A1] (P0) The "?" bucket drill reads its own endpoint and titles itself "Uncategorized".
  it('the Uncategorized drill asks for the sentinel id and titles the screen "Uncategorized"', async () => {
    setParams({ id: '__uncategorized__', cycle: '0' });
    server.seed('/categories/__uncategorized__/transactions', [{ ...ROW, category: null, amount: -20 }]);
    await renderWithApp(<CategoryDetail />);
    expect(server.sent('GET', '/categories/__uncategorized__/transactions')).toHaveLength(1);
    expect(screen.getAllByText('Uncategorized')).toHaveLength(2); // the header + the row's label
    expect(screen.getByText('$20')).toBeTruthy();
    expect(screen.getByText('Spent this cycle')).toBeTruthy();
  });

  // [A2] (P0) Retry after a hard read failure actually recovers: the detail replaces the error.
  it('Retry after a failed first read shows the detail once the server answers', async () => {
    server.once('GET', COFFEE_ROWS, { status: 500 });
    await renderWithApp(<CategoryDetail />);
    expect(screen.getByTestId('category-error')).toBeTruthy();

    fireEvent.press(screen.getByTestId('category-retry'));
    await waitFor(() => expect(screen.getByTestId('category-total')).toBeTruthy());
    expect(screen.queryByTestId('category-error')).toBeNull();
    expect(screen.getByText('$9')).toBeTruthy();
  });

  // [A3] (P0) Retry after the taxonomy failed re-reads /categories and the detail then renders.
  it('Retry after the category list failed shows the detail once the list loads', async () => {
    server.once('GET', '/categories', { status: 500 });
    await renderWithApp(<CategoryDetail />);
    expect(screen.getByTestId('category-error')).toBeTruthy();

    fireEvent.press(screen.getByTestId('category-retry'));
    await waitFor(() => expect(screen.getByTestId('category-total')).toBeTruthy());
    expect(screen.getAllByText('Cafes & Coffee').length).toBeGreaterThan(0);
  });

  // [A4] (P1) Both reads fail on a cold open → the error card, never a stuck spinner or a "$0".
  it('shows the error card when both the rows and the category list fail', async () => {
    server.fail(COFFEE_ROWS, 500);
    server.fail('/categories', 500);
    await renderWithApp(<CategoryDetail />);
    expect(screen.getByTestId('category-error')).toBeTruthy();
    expect(screen.queryByTestId('category-loading')).toBeNull();
    expect(screen.queryByTestId('category-total')).toBeNull();
  });

  // [A5] (P0) Moving from this cycle to last cycle re-reads with ?cycle=1 and shows last cycle's
  // rows, not this cycle's cached ones. Fail-on-revert: drop `cycle` from the query key and the
  // cached cycle-0 rows answer for cycle 1.
  it('switching to last cycle re-reads ?cycle=1 and shows that cycle\'s total, not the cached one', async () => {
    const view = await renderWithApp(<CategoryDetail />);
    expect(screen.getByText('$9')).toBeTruthy();

    server.once('GET', COFFEE_ROWS, { status: 200, body: [{ ...ROW, transaction_id: 't9', amount: -42 }] });
    setParams({ id: 'coffee', cycle: '1' });
    view.rerender(<WithApp><CategoryDetail /></WithApp>);
    await waitFor(() => expect(screen.getByText('$42')).toBeTruthy());
    expect(server.sent('GET', `${COFFEE_ROWS}?cycle=1`)).toHaveLength(1);
    expect(screen.getByText('Spent last cycle')).toBeTruthy();
    expect(screen.queryByText('$9')).toBeNull();
  });

  // [A6] (P1) A row filed under a category the taxonomy doesn't know still counts and lists.
  it('counts a row whose category is missing from the list (no crash, row listed)', async () => {
    server.seed(COFFEE_ROWS, [ROW, { ...ROW, transaction_id: 't2', amount: -1.5, category: 'gone', merchant_name: 'Ghost' }]);
    await renderWithApp(<CategoryDetail />);
    expect(screen.getByText('$10')).toBeTruthy();
    expect(screen.getByText('2 transactions')).toBeTruthy();
    expect(screen.getByText('Ghost')).toBeTruthy();
  });
});

describe('category edit edges', () => {
  // [A7] (P0) The category list FAILED (not just loading): editing an existing category must stay
  // blocked so Save can't write the default bucket/icon over the real one.
  it('blocks Save on an existing category when the category list fails to load', async () => {
    setParams({ categoryId: 'coffee' });
    server.fail('/categories', 500);
    await renderWithApp(<CategoryEdit />);
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Coffee runs'), 'Renamed');
    fireEvent.press(screen.getByText('Save category'));
    await refreshInAct(() => undefined);
    expect(categoryPatches()).toEqual([]);
  });

  // [A8] (P1) A background re-read that returns the same list must not re-seed the form over
  // what the user is typing. Fail-on-revert: turn off the query's structural sharing and the
  // fresh `existing` object re-runs the seed effect, wiping "Renamed".
  it('a background re-read with an unchanged list keeps the name the user is typing', async () => {
    setParams({ categoryId: 'coffee' });
    await renderWithApp(<CategoryEdit />);
    expect(screen.getByDisplayValue('Cafes & Coffee')).toBeTruthy();

    fireEvent.changeText(screen.getByPlaceholderText('e.g. Coffee runs'), 'Renamed');
    await refreshInAct(() => queryClient.refetchQueries());
    expect(server.sent('GET', '/categories')).toHaveLength(2);
    expect(screen.getByDisplayValue('Renamed')).toBeTruthy();

    fireEvent.press(screen.getByText('Save category'));
    await waitFor(() => expect(server.sent('PATCH', '/categories/coffee')).toHaveLength(1));
    expect(server.sent('PATCH', '/categories/coffee')[0].body).toEqual(
      { name: 'Renamed', bucket: 'Lifestyle', icon: 'coffee', parent: null },
    );
  });

  // A sub-category in a bucket other than the form's default (Lifestyle), under a same-bucket parent.
  const PARKING_UNDER_TRANSPORT = [
    { id: 'parking', name: 'Parking', bucket: 'Living', icon: 'car', parent: 'transport' },
    { id: 'transport', name: 'Transport', bucket: 'Living', icon: 'car', parent: null },
  ];
  const UNTOUCHED_SAVE = { name: 'Parking', bucket: 'Living', icon: 'car', parent: 'transport' };

  async function saveAndExpectUntouched() {
    fireEvent.press(screen.getByText('Save category'));
    await waitFor(() => expect(server.sent('PATCH', '/categories/parking')).toHaveLength(1));
    expect(server.sent('PATCH', '/categories/parking')[0].body).toEqual(UNTOUCHED_SAVE);
  }

  // [A9] (P1) Warm cache (the list already loaded when the form opens): a plain re-save keeps the
  // sub-category under its parent.
  it('warm open: re-saving a Living sub-category keeps its parent', async () => {
    server.seed('/categories', PARKING_UNDER_TRANSPORT);
    setParams({ categoryId: 'parking' });
    await renderLoaded(<CategoryEdit />, WithApp);
    await saveAndExpectUntouched();
  });

  // [A10] (P0) REAL BUG — cold open (the list lands after the form mounts, e.g. a deep link). The
  // late re-seed sets bucket=Living + parent=transport, but the "keep the parent valid" effect runs
  // in the same pass with the OLD bucket (Lifestyle), finds transport ineligible and clears it. A
  // plain re-save then silently moves Parking to the top level (app/category/edit.tsx:32-43).
  it('cold open: re-saving a Living sub-category keeps its parent (no silent detach)', async () => {
    server.seed('/categories', PARKING_UNDER_TRANSPORT);
    setParams({ categoryId: 'parking' });
    await renderWithApp(<CategoryEdit />);
    expect(screen.getByDisplayValue('Parking')).toBeTruthy();
    await saveAndExpectUntouched();
  });
});
