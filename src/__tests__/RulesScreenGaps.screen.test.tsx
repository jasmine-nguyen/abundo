// WHIT — Rules screen grouping/search: adversarial screen gaps not in
// RulesScreen.screen.test.tsx. Search box show/hide as rules load, intro count staying
// total while filtered, and the "Uncategorized" name collision rendering. [A24]-[A26]
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import type { AppContext, Rule, Category } from '../context';
import type { RulesScreenData } from '../queries';

type RulesState = Pick<AppContext, 'setSheet' | 'deleteRule'> & { category: (id: string | null) => Category | undefined };

let mockRules: RulesScreenData;
let mockCategories: Category[];
jest.mock('../queries', () => ({ useRulesScreenData: () => mockRules, useCategories: () => ({ categories: mockCategories, category: mockState.category, isLoading: false, isError: false, refetch: jest.fn(), refetchStale: jest.fn() }) }));

let mockState: RulesState;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});

jest.mock('../components/Header', () => ({ Header: () => null }));
jest.mock('expo-router', () => ({ useFocusEffect: () => {} }));

import Rules from '../../app/rules';

const fns = { setSheet: jest.fn(), deleteRule: jest.fn(), refetch: jest.fn(), refetchStale: jest.fn() };

const SUBS: Category = { id: 'subs', name: 'Subscriptions', icon: 'film', color: '#f0b27a', bucket: 'Lifestyle', recent: 0 };
const COFFEE: Category = { id: 'coffee', name: 'Cafes & Coffee', icon: 'coffee', color: '#e8a87c', bucket: 'Lifestyle', recent: 0 };

function rulesData(over: Partial<RulesScreenData> = {}): RulesScreenData {
  return { rules: [], isLoading: false, isError: false, rulesError: false, refetch: fns.refetch, refetchStale: fns.refetchStale, ...over };
}
function state(over: Partial<RulesState> = {}): RulesState {
  return {
    category: (id: string | null) => (id === 'subs' ? SUBS : id === 'coffee' ? COFFEE : undefined),
    setSheet: fns.setSheet as AppContext['setSheet'],
    deleteRule: fns.deleteRule as AppContext['deleteRule'],
    ...over,
  };
}

// WHIT-354: the filter is debounced (250ms); advance the fake clock after typing.
const settle = () => act(() => { jest.advanceTimersByTime(250); });

beforeEach(() => {
  jest.useFakeTimers();
  fns.setSheet.mockClear(); fns.deleteRule.mockClear(); fns.refetch.mockClear(); fns.refetchStale.mockClear();
  mockState = state();
  mockRules = rulesData();
  mockCategories = [SUBS, COFFEE];
});

afterEach(() => {
  jest.useRealTimers();
});

const TWO_RULES = [
  { id: 'e1', pattern: 'NETFLIX', categoryId: 'subs', isNew: false },
  { id: 'e2', pattern: 'STARBUCKS', categoryId: 'coffee', isNew: false },
] as Rule[];

// [A24] With zero rules and no query the pinned search box is hidden (nothing to search);
// it must appear once rules exist. Guards the `rules.length > 0 || query.length > 0` gate.
it('[A24] hides the search box when there are no rules, shows it once rules load', () => {
  mockRules = rulesData({ rules: [] });
  const { rerender } = render(<Rules />);
  expect(screen.queryByLabelText('Search rules')).toBeNull();

  mockRules = rulesData({ rules: TWO_RULES });
  rerender(<Rules />);
  expect(screen.getByLabelText('Search rules')).toBeTruthy();
});

// [A25] The intro line reports the TOTAL rule count and must not shrink when a search
// filters the visible list — it reads `rules` (raw), not the filtered groups.
it('[A25] intro count stays the total (2) even when the filter hides one rule', () => {
  mockRules = rulesData({ rules: TWO_RULES });
  render(<Rules />);
  expect(screen.getByText(/You have 2 active rules/)).toBeTruthy();

  fireEvent.changeText(screen.getByLabelText('Search rules'), 'netflix');
  settle();
  expect(screen.queryByText('STARBUCKS')).toBeNull(); // list filtered to one
  expect(screen.getByText(/You have 2 active rules/)).toBeTruthy(); // count unchanged
});

// [A26] A user-named "Uncategorized" category plus a genuinely orphaned rule renders TWO
// separate headers with that label — documents the collision the grouping doesn't merge.
it('[A26] renders two "Uncategorized" headers when a real category collides with orphans', () => {
  mockCategories = [{ id: 'real', name: 'Uncategorized', icon: 'tag', color: '#abc', bucket: 'Lifestyle', recent: 0 }];
  mockRules = rulesData({ rules: [
    { id: 'r1', pattern: 'REALONE', categoryId: 'real', isNew: false },
    { id: 'r2', pattern: 'GHOST', categoryId: 'deleted', isNew: false },
  ] as Rule[] });
  render(<Rules />);
  expect(screen.getAllByText('Uncategorized')).toHaveLength(2);
  expect(screen.getByText('REALONE')).toBeTruthy();
  expect(screen.getByText('GHOST')).toBeTruthy();
});
