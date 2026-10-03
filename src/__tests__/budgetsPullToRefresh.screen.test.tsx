// WHIT-713 (slice 1) — Budgets: pull down to refresh, and the quiet "couldn't refresh" line.
// Real ../api over the fake server; ../auth + expo-router use the shared mocks. The clock is
// pinned to 9:40am Melbourne so the line's "showing <time>" is a known literal: data loaded
// at the pinned time, and real timers never move the faked Date.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { RefreshControl } from 'react-native';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeClient } from './support/queryClient';
import { resetRouter } from './support/routerMock';
import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { pinToday } from './support/clock';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Budgets from '../../app/(tabs)/budgets';

const server = installFakeServer();
const budgetReads = () => server.sentUnder('GET', '/budgets?');

const PAY_CYCLE = { length: 30, last_pay_date: '2026-09-01' };
const CATS = [{ id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 52 }];
const BUDGETS = { coffee: { target: 100, posted: 40, pending: 10 } };

async function renderLoadedBudgets() {
  render(React.createElement(QueryClientProvider, { client: makeClient() }, React.createElement(Budgets)));
  expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
}

const pullControl = () => screen.UNSAFE_getByType(RefreshControl);

async function pullAndSettle() {
  act(() => { pullControl().props.onRefresh(); });
  await waitFor(() => expect(pullControl().props.refreshing).toBe(false));
}

beforeEach(() => {
  pinToday(new Date('2026-09-18T09:40:00+10:00'));
  resetAuth();
  resetRouter();
  server.seed('/budgets', BUDGETS);
  server.seed('/categories', CATS);
  server.seed('/paycycle', PAY_CYCLE);
});

afterEach(() => {
  jest.useRealTimers();
});

it('user can pull down on Budgets to refetch, and the pull spinner clears', async () => {
  await renderLoadedBudgets();
  expect(budgetReads()).toHaveLength(1);

  const held = server.hold('/budgets');
  act(() => { pullControl().props.onRefresh(); });
  await waitFor(() => expect(budgetReads()).toHaveLength(2));
  expect(pullControl().props.refreshing).toBe(true);

  held.release();
  await waitFor(() => expect(pullControl().props.refreshing).toBe(false));
  expect(screen.getByText('Cafes & Coffee')).toBeTruthy();
});

it('a failed refresh over showing budgets keeps the rows and says "Couldn\'t refresh · showing <time>", cleared by a good pull', async () => {
  await renderLoadedBudgets();
  expect(screen.queryByTestId('budgets-stale')).toBeNull();

  server.once('GET', '/budgets', { status: 503 });
  await pullAndSettle();

  await waitFor(() => expect(screen.getByTestId('budgets-stale')).toBeTruthy());
  expect(screen.getByTestId('budgets-stale')).toHaveTextContent("Couldn't refresh · showing 9:40am");
  expect(screen.getByText('Cafes & Coffee')).toBeTruthy();
  expect(screen.queryByTestId('budgets-error')).toBeNull();

  await pullAndSettle();
  await waitFor(() => expect(screen.queryByTestId('budgets-stale')).toBeNull());
  expect(screen.getByText('Cafes & Coffee')).toBeTruthy();
});

it('a refresh that loses the connection says "You look offline · showing <time>"', async () => {
  await renderLoadedBudgets();

  server.once('GET', '/budgets', 'dropped');
  await pullAndSettle();

  await waitFor(() => expect(screen.getByTestId('budgets-stale')).toHaveTextContent('You look offline · showing 9:40am'));
  expect(screen.getByText('Cafes & Coffee')).toBeTruthy();
});

it('the Budgets error card says you look offline when the first load loses the connection', async () => {
  server.once('GET', '/budgets', 'dropped');
  render(React.createElement(QueryClientProvider, { client: makeClient() }, React.createElement(Budgets)));
  expect(await screen.findByTestId('budgets-error')).toBeTruthy();
  expect(screen.getByText("Couldn't load your budgets.")).toBeTruthy();
  expect(screen.getByText('You look offline. Check your connection and retry.')).toBeTruthy();
  expect(screen.queryByTestId('budgets-stale')).toBeNull();
});

it('the Budgets error card blames the server on a 5xx first load, and Retry still recovers', async () => {
  server.fail('/budgets', 503);
  render(React.createElement(QueryClientProvider, { client: makeClient() }, React.createElement(Budgets)));
  expect(await screen.findByTestId('budgets-error')).toBeTruthy();
  expect(screen.getByText('Our server had a problem. Try again in a moment.')).toBeTruthy();

  server.once('GET', '/budgets', { body: BUDGETS });
  fireEvent.press(screen.getByTestId('budgets-retry'));
  expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
});
