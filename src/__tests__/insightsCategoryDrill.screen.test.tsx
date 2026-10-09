// WHIT-308 — tapping an Insights spend row drills into that category's transactions. A leaf,
// a "Directly in X" (synthetic) row, and Uncategorized each navigate to /category/<drillId>
// carrying the selected cycle; a PARENT row still expands its subs instead of navigating.
// Same harness as insightsCycleToggle.gaps: real ../api over the fake server; ../auth + ../context
// (partial) + expo-router mocked, with a CAPTURED router.push so the navigation target is asserted.
import { it, expect, jest, beforeEach } from '@jest/globals';
import { routerSpies, resetRouter } from './support/routerMock';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeClient } from './support/queryClient';
import { installFakeServer } from './support/fakeServer';

jest.mock('../auth', () => require('./support/authMock').authMockModule());

jest.mock('../hooks/useAiInsights', () => require('./support/insightsScreen').useAiInsightsMockModule());

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Insights from '../../app/(tabs)/insights';

const server = installFakeServer();

const PAY_CYCLE = { length: 30, last_pay_date: '2026-07-01' };
// A parent (Food) with a spending child (Coffee) AND its own direct spend → categoryBreakdown
// emits a "Directly in Food" synthetic row. Plus the Uncategorized bucket.
const CATS = [
  { id: 'food', name: 'Food', bucket: 'Essentials', icon: 'cart', color: '#7FD49B' },
  { id: 'coffee', name: 'Coffee', bucket: 'Essentials', icon: 'coffee', color: '#E8A87C', parent: 'food' },
];
const BREAKDOWN = {
  food: { posted: 30, pending: 0 },
  coffee: { posted: 20, pending: 0 },
  __uncategorized__: { posted: 14, pending: 0 },
  __rollup__: { nodes: { food: { posted: 50, pending: 0 } } },  // netted parent = direct 30 + coffee 20
};

function renderInsights() {
  return render(React.createElement(QueryClientProvider, { client: makeClient() }, React.createElement(Insights)));
}

beforeEach(() => {
  resetRouter();
  server.seed('/breakdown', BREAKDOWN);
  server.seed('/categories', CATS);
  server.seed('/paycycle', PAY_CYCLE);
});

it('tapping a leaf row drills into that category for the current cycle', async () => {
  renderInsights();
  await screen.findByText('Food');
  fireEvent.press(screen.getByText('Food'));            // expand the parent to reveal its subs
  fireEvent.press(await screen.findByText('Coffee'));   // leaf
  expect(routerSpies.push).toHaveBeenCalledWith('/category/coffee?cycle=0');
});

it('tapping a "Directly in X" row drills into the PARENT id (no __direct in the path)', async () => {
  renderInsights();
  await screen.findByText('Food');
  fireEvent.press(screen.getByText('Food'));
  fireEvent.press(await screen.findByText('Directly in Food'));
  expect(routerSpies.push).toHaveBeenCalledWith('/category/food?cycle=0');
});

it('tapping Uncategorized drills into the uncategorized bucket', async () => {
  renderInsights();
  fireEvent.press(await screen.findByText('Uncategorized'));
  expect(routerSpies.push).toHaveBeenCalledWith('/category/__uncategorized__?cycle=0');
});

it('tapping a PARENT row expands it instead of navigating', async () => {
  renderInsights();
  fireEvent.press(await screen.findByText('Food'));
  expect(await screen.findByText('Coffee')).toBeTruthy(); // subs revealed
  expect(routerSpies.push).not.toHaveBeenCalled();                // no drill
});

it('carries the selected cycle: on "Last cycle" the drill pushes cycle=1', async () => {
  renderInsights();
  await screen.findByText('Uncategorized');
  fireEvent.press(screen.getByTestId('insights-cycle-prev')); // switch to last cycle
  fireEvent.press(await screen.findByText('Uncategorized'));
  expect(routerSpies.push).toHaveBeenCalledWith('/category/__uncategorized__?cycle=1');
});
