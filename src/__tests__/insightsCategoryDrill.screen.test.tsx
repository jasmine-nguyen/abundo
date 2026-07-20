// WHIT-308 — tapping an Insights spend row drills into that category's transactions. A leaf,
// a "Directly in X" (synthetic) row, and Uncategorized each navigate to /category/<drillId>
// carrying the selected cycle; a PARENT row still expands its subs instead of navigating.
// Same mock shape as insightsCycleToggle.gaps: ../api + ../auth + ../context (partial) +
// expo-router mocked, with a CAPTURED router.push so the navigation target is asserted.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));

const mockFetchBreakdown = jest.fn<(days: number, cycle?: number) => Promise<unknown>>();
const mockFetchCategories = jest.fn<() => Promise<unknown>>();
const mockFetchPayCycle = jest.fn<() => Promise<unknown>>();
jest.mock('../api', () => ({
  fetchBreakdown: (...a: unknown[]) => mockFetchBreakdown(...(a as [number, number?])),
  fetchCategories: () => mockFetchCategories(),
  fetchPayCycle: () => mockFetchPayCycle(),
}));

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return {
    ...actual,
    useAppContext: () => ({
      aiInsights: null, aiInsightsLoading: false, aiInsightsError: false,
      refreshAiInsights: jest.fn(), generateAiInsights: jest.fn(),
      loanFacts: { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null },
      homeLoan: { balance: null, asOf: null },
    }),
  };
});

const mockPush = jest.fn();
jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return { useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]), useRouter: () => ({ push: mockPush }) };
});

import Insights from '../../app/(tabs)/insights';

const PAY_CYCLE = { length: 30, last_pay_date: '2026-07-01' };
// A parent (Food) with a spending child (Coffee) AND its own direct spend → categoryBreakdown
// emits a "Directly in Food" synthetic row. Plus the Uncategorized bucket.
const CATS = [
  { id: 'food', name: 'Food', bucket: 'Essentials', icon: 'cart', color: '#7FD49B', recent: 0 },
  { id: 'coffee', name: 'Coffee', bucket: 'Essentials', icon: 'coffee', color: '#E8A87C', recent: 0, parent: 'food' },
];
const BREAKDOWN = {
  food: { posted: 30, pending: 0 },
  coffee: { posted: 20, pending: 0 },
  __uncategorized__: { posted: 14, pending: 0 },
};

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: Infinity } } });
}
function renderInsights() {
  return render(React.createElement(QueryClientProvider, { client: makeClient() }, React.createElement(Insights)));
}

beforeEach(() => {
  mockPush.mockReset();
  mockFetchBreakdown.mockReset().mockResolvedValue(BREAKDOWN);
  mockFetchCategories.mockReset().mockResolvedValue(CATS);
  mockFetchPayCycle.mockReset().mockResolvedValue(PAY_CYCLE);
});

it('tapping a leaf row drills into that category for the current cycle', async () => {
  renderInsights();
  await screen.findByText('Food');
  fireEvent.press(screen.getByText('Food'));            // expand the parent to reveal its subs
  fireEvent.press(await screen.findByText('Coffee'));   // leaf
  expect(mockPush).toHaveBeenCalledWith('/category/coffee?cycle=0');
});

it('tapping a "Directly in X" row drills into the PARENT id (no __direct in the path)', async () => {
  renderInsights();
  await screen.findByText('Food');
  fireEvent.press(screen.getByText('Food'));
  fireEvent.press(await screen.findByText('Directly in Food'));
  expect(mockPush).toHaveBeenCalledWith('/category/food?cycle=0');
});

it('tapping Uncategorized drills into the uncategorized bucket', async () => {
  renderInsights();
  fireEvent.press(await screen.findByText('Uncategorized'));
  expect(mockPush).toHaveBeenCalledWith('/category/__uncategorized__?cycle=0');
});

it('tapping a PARENT row expands it instead of navigating', async () => {
  renderInsights();
  fireEvent.press(await screen.findByText('Food'));
  expect(await screen.findByText('Coffee')).toBeTruthy(); // subs revealed
  expect(mockPush).not.toHaveBeenCalled();                // no drill
});

it('carries the selected cycle: on "Last cycle" the drill pushes cycle=1', async () => {
  renderInsights();
  await screen.findByText('Uncategorized');
  fireEvent.press(screen.getByTestId('insights-cycle-prev')); // switch to last cycle
  fireEvent.press(await screen.findByText('Uncategorized'));
  expect(mockPush).toHaveBeenCalledWith('/category/__uncategorized__?cycle=1');
});
