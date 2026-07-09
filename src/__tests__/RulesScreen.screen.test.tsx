// Screen test: the Rules screen (WHIT-52 Slice 2). Verifies the loading and
// error+retry states and that a loaded rule renders + its trash button calls
// deleteRule. WHIT-195: the rule list now comes from the cached ['rules'] query, so
// useRulesScreenData is mocked; setSheet/deleteRule/category stay on the store.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import type { AppContext, Rule, Category } from '../context';
import type { RulesScreenData } from '../queries';

// WHIT-192: rules.tsx reads only setSheet + deleteRule off the store; the taxonomy comes
// from useCategories (query layer). The fixture carries those writers PLUS a category()
// lookup purely to feed the mocked useCategories below.
type RulesState = Pick<AppContext, 'setSheet' | 'deleteRule'> & { category: (id: string | null) => Category | undefined };

let mockRules: RulesScreenData;
jest.mock('../queries', () => ({ useRulesScreenData: () => mockRules, useCategories: () => ({ categories: [], category: mockState.category, isLoading: false, isError: false, refetch: jest.fn(), refetchStale: jest.fn() }) }));

let mockState: RulesState;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});

// Header pulls in expo-router (a native module that can't load headlessly) and
// isn't under test here — stub it out so the screen renders in jest.
jest.mock('../components/Header', () => ({ Header: () => null }));
jest.mock('expo-router', () => ({ useFocusEffect: () => {} }));

import Rules from '../../app/rules';

const fns = {
  setSheet: jest.fn(),
  deleteRule: jest.fn(),
  refetch: jest.fn(),
  refetchStale: jest.fn(),
};

function rulesData(over: Partial<RulesScreenData> = {}): RulesScreenData {
  return {
    rules: [],
    isLoading: false,
    isError: false,
    rulesError: false,
    refetch: fns.refetch,
    refetchStale: fns.refetchStale,
    ...over,
  };
}

function state(over: Partial<RulesState> = {}): RulesState {
  return {
    category: (id: string | null) =>
      id === 'subs' ? { id: 'subs', name: 'Subscriptions', icon: 'film', color: '#f0b27a', bucket: 'Lifestyle', recent: 0 } : undefined,
    setSheet: fns.setSheet as AppContext['setSheet'],
    deleteRule: fns.deleteRule as AppContext['deleteRule'],
    ...over,
  };
}

beforeEach(() => {
  fns.setSheet.mockClear();
  fns.deleteRule.mockClear();
  fns.refetch.mockClear();
  fns.refetchStale.mockClear();
  mockState = state();
  mockRules = rulesData();
});

it('shows a loading state while rules load (nothing cached yet)', () => {
  mockRules = rulesData({ isLoading: true, rules: [] });
  render(<Rules />);
  expect(screen.getByText('Loading rules…')).toBeTruthy();
});

it('shows an error with a retry that refetches', () => {
  mockRules = rulesData({ isError: true });
  render(<Rules />);
  expect(screen.getByText('Could not load your rules.')).toBeTruthy();
  // WHIT-198 GAP (authored by qa) — Rules' retry migrated to the shared RetryButton. Pressing by
  // visible text alone would pass for a bare Pressable too, so lock the a11y contract (role +
  // label) a revert would drop. Second migrated screen locked (with Budgets + Transactions).
  const retry = screen.getByTestId('rules-retry');
  expect(retry.props.accessibilityRole).toBe('button');
  expect(retry.props.accessibilityLabel).toBe('Retry loading your rules');
  fireEvent.press(retry);
  expect(fns.refetch).toHaveBeenCalled();
});

it('renders a rule and deletes it via the trash button', () => {
  mockRules = rulesData({ rules: [{ id: 'e1', pattern: 'NETFLIX', categoryId: 'subs', isNew: false }] as Rule[] });
  render(<Rules />);
  expect(screen.getByText('NETFLIX')).toBeTruthy();
  expect(screen.getByText('Subscriptions')).toBeTruthy();
  fireEvent.press(screen.getByTestId('delete-rule-e1'));
  expect(fns.deleteRule).toHaveBeenCalledWith('e1');
});

it('tapping a rule body opens the edit sheet with its id', () => {
  mockRules = rulesData({ rules: [{ id: 'e1', pattern: 'NETFLIX', categoryId: 'subs', isNew: false }] as Rule[] });
  render(<Rules />);
  fireEvent.press(screen.getByTestId('edit-rule-e1'));
  expect(fns.setSheet).toHaveBeenCalledWith({ mode: 'addrule', ruleId: 'e1' });
});

it('renders the NEW badge on a freshly-created rule (isNew survives the cache mirror)', () => {
  mockRules = rulesData({ rules: [{ id: 'e1', pattern: 'NETFLIX', categoryId: 'subs', isNew: true }] as Rule[] });
  render(<Rules />);
  expect(screen.getByText('NEW')).toBeTruthy();
});
