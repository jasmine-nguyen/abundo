// WHIT-221 — the Budgets screen renders the parent -> sub tree and the DE-DUPED hero.
// Drives the whole query -> selectBudgets -> budgetViews -> render pipeline (mirrors
// budgetsQuery.screen.test.tsx) so the wiring, not just the pure selector, is proven:
// - [A26] the "of $X" pill counts the parent's cap ONCE (not parent + sub)
// - [A27] the child row is visually indented (marginLeft > 0); the parent is not
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

jest.mock('../auth', () => ({
  getStatus: () => 'authed',
  subscribe: () => () => {},
}));

const mockFetchBudgets = jest.fn<(days: number) => Promise<unknown>>();
const mockFetchCategories = jest.fn<() => Promise<unknown>>();
const mockFetchPayCycle = jest.fn<() => Promise<unknown>>();
jest.mock('../api', () => ({
  fetchBudgets: (...a: unknown[]) => mockFetchBudgets(...(a as [number])),
  fetchCategories: () => mockFetchCategories(),
  fetchPayCycle: () => mockFetchPayCycle(),
}));

jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return {
    useRouter: () => ({ push: jest.fn() }),
    useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]),
  };
});

import Budgets from '../../app/(tabs)/budgets';

const PAY_CYCLE = { length: 14, last_pay_date: '2026-07-01' };
// Car (parent) rolled-up spend 75 of 200; Parking (sub of Car) 30 of 50. Same bucket.
const CATS = [
  { id: 'car', name: 'Car', bucket: 'Living', icon: 'car', color: '#7fd1b9', recent: 3, parent: null },
  { id: 'parking', name: 'Parking', bucket: 'Living', icon: 'car', color: '#7fd1b9', recent: 1, parent: 'car' },
];
const BUDGETS = {
  car: { target: 200, posted: 75, pending: 0 },
  parking: { target: 50, posted: 30, pending: 0 },
};

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: Infinity } } });
}
function renderBudgets() {
  return render(React.createElement(QueryClientProvider, { client: makeClient() }, React.createElement(Budgets)));
}

// Flatten a host element's style prop (array | object | StyleSheet-ref) into one object.
// StyleSheet.create refs spread to nothing; only inline objects (the indent block) carry
// through — exactly what we want to detect.
function flatStyle(node: any): Record<string, unknown> {
  const s = node?.props?.style;
  const arr = Array.isArray(s) ? s : [s];
  return arr.reduce((acc, cur) => (cur && typeof cur === 'object' ? { ...acc, ...cur } : acc), {} as Record<string, unknown>);
}
// Walk up from a text node and return the first ancestor inline style carrying a numeric
// marginLeft (the depth indent block), or {} if none — the parent row has no indent block.
function indentStyleFor(name: string): Record<string, unknown> {
  let node: any = screen.getByText(name);
  for (let i = 0; i < 8 && node; i++) {
    const st = flatStyle(node);
    if (typeof st.marginLeft === 'number') return st;
    node = node.parent;
  }
  return {};
}

beforeEach(() => {
  mockFetchBudgets.mockReset().mockResolvedValue(BUDGETS);
  mockFetchCategories.mockReset().mockResolvedValue(CATS);
  mockFetchPayCycle.mockReset().mockResolvedValue(PAY_CYCLE);
});

it('[A26] hero de-dups: the "of" pill counts the parent cap once, not parent + sub', async () => {
  renderBudgets();
  expect(await screen.findByText('Car')).toBeTruthy();
  expect(screen.getByText('Parking')).toBeTruthy();      // both rows render
  expect(screen.getByText('of $200')).toBeTruthy();      // Car only
  expect(screen.queryByText('of $250')).toBeNull();      // NOT Car + Parking
  // Reverting the `depth === 0` guard makes totBudget 250 -> the pill flips to "of $250".
});

it('[A27] the child row is indented and the parent row is not', async () => {
  renderBudgets();
  await screen.findByText('Car');
  expect(indentStyleFor('Car').marginLeft ?? 0).toBe(0);   // depth 0 -> no indent block
  const child = indentStyleFor('Parking');
  expect(child.marginLeft).toBe(18);                       // depth 1 -> 1 * 18
  expect(child.borderLeftWidth).toBe(2);                   // indent rail present
});
