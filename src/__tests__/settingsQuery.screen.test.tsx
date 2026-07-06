// WHIT-191a — the Settings server-backed rows (categories count + loan-facts status)
// on the real query layer: not fetched before login, fires on auth flip, self-heals a
// transient 5xx, and shows "…" (never a misleading "0") while first-loading. ../api +
// ../auth + expo-router mocked; ../context PARTIALLY mocked (real selectors + composite
// deps, stubbed useAppContext for the store-backed rows); real QueryClientProvider.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let mockAuthStatus = 'authed';
const mockAuthListeners = new Set<() => void>();
jest.mock('../auth', () => ({
  getStatus: () => mockAuthStatus,
  subscribe: (l: () => void) => {
    mockAuthListeners.add(l);
    return () => mockAuthListeners.delete(l);
  },
  getCurrentUser: () => null,
  signOut: jest.fn(),
}));
function setAuth(next: string) {
  mockAuthStatus = next;
  mockAuthListeners.forEach((l) => l());
}

const mockFetchCategories = jest.fn<() => Promise<unknown>>();
const mockFetchLoanFacts = jest.fn<() => Promise<unknown>>();
jest.mock('../api', () => ({
  fetchCategories: () => mockFetchCategories(),
  fetchLoanFacts: () => mockFetchLoanFacts(),
}));

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return {
    ...actual,
    useAppContext: () => ({ rules: [], cycleName: () => 'Fortnightly', alerts: true, toggleAlerts: jest.fn(), setSheet: jest.fn() }),
  };
});

jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return { useRouter: () => ({ push: jest.fn(), replace: jest.fn() }), useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]) };
});

import Settings from '../../app/(tabs)/settings';

const CATS = [
  { id: 'a', name: 'A', bucket: 'Living', icon: 'cart', color: '#7FD49B', recent: 0 },
  { id: 'b', name: 'B', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 0 },
  { id: 'c', name: 'C', bucket: 'Living', icon: 'home', color: '#8AB4F8', recent: 0 },
];
const READY_FACTS = { original: 500000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200 };
const EMPTY_FACTS = { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null };

function makeClient(retry: boolean | number = false) {
  return new QueryClient({ defaultOptions: { queries: { retry, retryDelay: 1, staleTime: 60_000, gcTime: Infinity } } });
}
function renderSettings(client = makeClient()) {
  return render(React.createElement(QueryClientProvider, { client }, React.createElement(Settings)));
}

beforeEach(() => {
  mockAuthStatus = 'authed';
  mockAuthListeners.clear();
  mockFetchCategories.mockReset().mockResolvedValue(CATS);
  mockFetchLoanFacts.mockReset().mockResolvedValue(READY_FACTS);
});

it('shows the category count and "Edit" loan status from the query', async () => {
  renderSettings();
  expect(await screen.findByText('3')).toBeTruthy(); // 3 categories
  expect(screen.getByText('Edit')).toBeTruthy(); // ready loan facts
});

it('shows "Set up" when loan facts are not filled in', async () => {
  mockFetchLoanFacts.mockReset().mockResolvedValue(EMPTY_FACTS);
  renderSettings();
  await screen.findByText('3');
  expect(screen.getByText('Set up')).toBeTruthy();
});

it('shows "…" (not "0") while first-loading, then the real count', async () => {
  let resolveCats: (v: unknown) => void = () => {};
  mockFetchCategories.mockReset().mockReturnValue(new Promise((r) => { resolveCats = r; }));
  renderSettings();
  // Both server-backed rows (categories count + loan status) show "…" while first-
  // loading — the count never flashes a misleading "0".
  expect(screen.getAllByText('…').length).toBe(2);
  await act(async () => { resolveCats(CATS); });
  expect(await screen.findByText('3')).toBeTruthy();
});

it('does not fetch before login, then fires on auth flip to authed', async () => {
  mockAuthStatus = 'anon';
  renderSettings();
  expect(mockFetchCategories).not.toHaveBeenCalled();
  expect(mockFetchLoanFacts).not.toHaveBeenCalled();

  await act(async () => { setAuth('authed'); });
  expect(await screen.findByText('3')).toBeTruthy();
  expect(mockFetchLoanFacts).toHaveBeenCalled();
});

it('a transient 5xx on the loan-facts read retries and self-heals', async () => {
  mockFetchLoanFacts.mockReset().mockRejectedValueOnce(new Error('API error: 503')).mockResolvedValue(READY_FACTS);
  renderSettings(makeClient(2));
  expect(await screen.findByText('Edit')).toBeTruthy();
  expect(mockFetchLoanFacts).toHaveBeenCalledTimes(2);
});
