// WHIT-226 — Insights Breakdown parent→sub drill-down: adversarial SCREEN gaps.
// The implementer's breakdown.logic tests cover the PURE selector (tree shape, de-dup,
// synthetic row). They do NOT render app/(tabs)/insights.tsx, so the expand/collapse
// interaction, the parent-chain visibility gate, and the hero "N categories" top-level
// count are untested. This file locks exactly those:
//   [A9]  parents render COLLAPSED by default — subs hidden
//   [A10] tapping a parent reveals its subs (indented); tapping again hides them
//   [A11] a grandchild stays hidden until BOTH ancestors are expanded (chain gate)
//   [A12] the hero "N categories" is the TOP-LEVEL count, not the flat row count
//   [A13] a parent's accessibilityState.expanded tracks the open/closed state (a11y)
// Same harness as insightsBreakdownQuery.screen.test.tsx: real ../api over the fake server;
// ../auth + expo-router mocked; ../context PARTIALLY mocked (real categoryBreakdown, stub useAppContext).
//
// WHIT-467 folded in insightsPayCycleParallel (WHIT-72 GAP) — same harness + timer regime.
// Its coffee fixtures differ from this file's tree fixtures, so it lives in its own describe
// with a nested beforeEach that re-seeds all three reads (runs after the outer one → wins).
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeClient } from './support/queryClient';
import { installFakeServer } from './support/fakeServer';
import { styleOf } from './support/layout';

jest.mock('../auth', () => require('./support/authMock').authMockModule());

jest.mock('../context', () => require('./support/insightsScreen').contextMockModule());

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Insights from '../../app/(tabs)/insights';
import { COFFEE } from './support/categories';

const server = installFakeServer();

const PAY_CYCLE = { length: 30, last_pay_date: '2026-07-01' };
// Two top-level trees: Food → {Groceries, Restaurants} and Car → Daily → Petrol.
const CATS = [
  { id: 'food', name: 'Food', bucket: 'Living', icon: 'coffee', color: '#7FD49B', parent: null },
  { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'coffee', color: '#7FD49B', parent: 'food' },
  { id: 'restaurants', name: 'Restaurants', bucket: 'Living', icon: 'coffee', color: '#E8A87C', parent: 'food' },
  { id: 'car', name: 'Car', bucket: 'Living', icon: 'coffee', color: '#6f7bf0', parent: null },
  { id: 'daily', name: 'Daily', bucket: 'Living', icon: 'coffee', color: '#6f7bf0', parent: 'car' },
  { id: 'petrol', name: 'Petrol', bucket: 'Living', icon: 'coffee', color: '#6f7bf0', parent: 'daily' },
];
const BREAKDOWN = {
  groceries: { posted: 80, pending: 0 },
  restaurants: { posted: 40, pending: 20 },
  petrol: { posted: 90, pending: 0 },
  __rollup__: {
    nodes: {
      food: { posted: 120, pending: 20 },   // groceries 80 + restaurants 60
      car: { posted: 90, pending: 0 },       // rolls up the grandchild
      daily: { posted: 90, pending: 0 },
    },
  },
};

function renderInsights() {
  return render(React.createElement(QueryClientProvider, { client: makeClient() }, React.createElement(Insights)));
}
// Walk up from a text node to the nearest ancestor View carrying a numeric marginLeft
// (the depth indent). Returns that indent, or 0 if none — proof a sub is nested.
function indentOf(label: string): number {
  let n: any = screen.getByText(label);
  while (n) {
    const st = styleOf(n);
    if (st && typeof st.marginLeft === 'number') return st.marginLeft;
    n = n.parent;
  }
  return 0;
}

beforeEach(() => {
  server.seed('/breakdown', BREAKDOWN);
  server.seed('/categories', CATS);
  server.seed('/paycycle', PAY_CYCLE);
});

it('[A9] parents render collapsed by default — subs are hidden', async () => {
  renderInsights();
  expect(await screen.findByText('Food')).toBeTruthy();
  expect(screen.getByText('Car')).toBeTruthy();
  // subs of BOTH trees hidden until their parent is tapped
  expect(screen.queryByText('Groceries')).toBeNull();
  expect(screen.queryByText('Restaurants')).toBeNull();
  expect(screen.queryByText('Daily')).toBeNull();
  expect(screen.queryByText('Petrol')).toBeNull();
});

it('[A10] tapping a parent reveals its (indented) subs; tapping again hides them', async () => {
  renderInsights();
  fireEvent.press(await screen.findByText('Food'));
  // both direct children appear...
  expect(await screen.findByText('Groceries')).toBeTruthy();
  expect(screen.getByText('Restaurants')).toBeTruthy();
  // ...and they're indented (depth-1 marginLeft > 0), unlike the top-level parent
  expect(indentOf('Groceries')).toBeGreaterThan(0);
  // the OTHER tree stays collapsed — only Food was toggled
  expect(screen.queryByText('Daily')).toBeNull();

  fireEvent.press(screen.getByText('Food'));
  expect(screen.queryByText('Groceries')).toBeNull();
  expect(screen.queryByText('Restaurants')).toBeNull();
});

it('[A11] a grandchild stays hidden until BOTH ancestors are expanded', async () => {
  renderInsights();
  // expand Car → Daily shows, Petrol (grandchild) still hidden
  fireEvent.press(await screen.findByText('Car'));
  expect(await screen.findByText('Daily')).toBeTruthy();
  expect(screen.queryByText('Petrol')).toBeNull();
  // expand Daily → the grandchild finally shows
  fireEvent.press(screen.getByText('Daily'));
  expect(await screen.findByText('Petrol')).toBeTruthy();
  // collapse the TOP ancestor → the whole chain (Daily + Petrol) disappears,
  // even though Daily is still in the expanded set (chain gate, not per-row)
  fireEvent.press(screen.getByText('Car'));
  expect(screen.queryByText('Daily')).toBeNull();
  expect(screen.queryByText('Petrol')).toBeNull();
});

it('[A12] the hero shows the TOP-LEVEL count, not the flat row count', async () => {
  renderInsights();
  // 2 top-level trees (Food, Car) — NOT the 3 leaves / 5 total rows
  expect(await screen.findByText('spent across 2 categories')).toBeTruthy();
  // expanding must NOT change the headline count
  fireEvent.press(screen.getByText('Food'));
  await screen.findByText('Groceries');
  expect(screen.getByText('spent across 2 categories')).toBeTruthy();
  expect(screen.queryByText('spent across 3 categories')).toBeNull();
  expect(screen.queryByText('spent across 4 categories')).toBeNull();
});

it('[A13] a parent accessibilityState.expanded tracks open/closed', async () => {
  renderInsights();
  await screen.findByText('Food');
  const foodBtns = screen.getAllByRole('button', { name: /Food/i });
  // the parent row is the button whose a11y state exposes `expanded`
  const foodRow = foodBtns.find((b: any) => b.props.accessibilityState && 'expanded' in b.props.accessibilityState)!;
  expect(foodRow.props.accessibilityState.expanded).toBe(false);
  fireEvent.press(screen.getByText('Food'));
  await screen.findByText('Groceries');
  const foodRow2 = screen.getAllByRole('button', { name: /Food/i })
    .find((b: any) => b.props.accessibilityState && 'expanded' in b.props.accessibilityState)!;
  expect(foodRow2.props.accessibilityState.expanded).toBe(true);
});

// --- WHIT-72 GAP (qa's adversarial half, folded in by WHIT-467) ---------------
// The Insights exclusion is only safe if the hero is genuinely cycle-INDEPENDENT
// (categoryBreakdown takes {breakdown, category} only). This locks that: with the pay cycle
// held unresolved, the breakdown hero still paints its total. Fail-on-revert: re-gating the
// breakdown/hero behind the pay cycle strands this on "Loading…".
// Its own coffee fixtures + nested beforeEach (re-seeds ALL three fetchers) keep it isolated
// from this file's tree fixtures.
describe('cycle-independent hero (pay cycle pending)', () => {
  const CATS = [{ ...COFFEE }];
  const BREAKDOWN = { coffee: { posted: 40, pending: 10 } };

  beforeEach(() => {
    server.seed('/breakdown', BREAKDOWN);
    server.seed('/categories', CATS);
    server.seed('/paycycle', { length: 30, last_pay_date: '2026-07-01' });
  });

  it('renders the breakdown hero while the pay cycle is STILL pending (cycle-independent hero → Insights exclusion is safe)', async () => {
    // Hold the pay cycle unresolved; breakdown + categories resolve. The hero must paint its
    // total anyway — it reads breakdown, never the cycle. On a payCycle-gated hero it would sit
    // on "Loading…" until the (held) cycle landed.
    const held = server.hold('/paycycle');
    render(React.createElement(QueryClientProvider, { client: makeClient() }, React.createElement(Insights)));

    expect(await screen.findByText('spent across 1 category')).toBeTruthy(); // hero painted from breakdown
    expect(screen.queryByText('Loading…')).toBeNull();
    expect(server.sent('GET', '/breakdown?days=14')).toHaveLength(1); // parallel, default length, current cycle (WHIT-68); server derives the window

    await act(async () => { held.release(); }); // settle to avoid act() leak
  });
});
