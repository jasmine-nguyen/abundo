// WHIT-354 — Rules screen SectionList/debounce perf change. Adversarial GAPS not in
// RulesScreen.screen.test.tsx / RulesScreenGaps.screen.test.tsx:
//   [G1] large list: windowing keeps the top (first row + header + footer + intro) usable
//   [G4] an orphan-only list renders under exactly one "Uncategorized" SectionList section
//   [G5] intro + "Add a rule" footer render in the error / loading / no-match states
//   [G6] keyboardShouldPersistTaps + non-sticky headers props locked; delete still fires
//   [G7] the debounce timer is cancelled on unmount (no leak between tests / after teardown)
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act, renderHook } from '@testing-library/react-native';
import type { AppContext, Rule, Category } from '../context';
import type { RulesScreenData } from '../queries';
import { useDebouncedValue } from '../hooks/useDebouncedValue';

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

const settle = () => act(() => { jest.advanceTimersByTime(250); });

const TWO_RULES = [
  { id: 'e1', pattern: 'NETFLIX', categoryId: 'subs', isNew: false },
  { id: 'e2', pattern: 'STARBUCKS', categoryId: 'coffee', isNew: false },
] as Rule[];

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

// [G1] Smoke test for the SectionList swap on a large list: the top of the list stays usable
// — first row, its section header, the intro header and the add-rule footer all render. (This
// asserts presence of the top, not virtualization itself — RNTL has no viewport to window
// against, so it can't prove off-screen rows are skipped; that's a device check, [M1]/[M2].)
it('[G1] a large (60-rule) list still renders the first row, its header, the intro and the footer', () => {
  const rules = Array.from({ length: 60 }, (_, i) => ({ id: `e${i}`, pattern: `RULE${i}`, categoryId: 'subs', isNew: false })) as Rule[];
  mockRules = rulesData({ rules });
  render(<Rules />);
  expect(screen.getByTestId('edit-rule-e0')).toBeTruthy();
  expect(screen.getByText('Subscriptions')).toBeTruthy();
  expect(screen.getByText(/You have 60 active rules/)).toBeTruthy();
  expect(screen.getByText('Add a rule')).toBeTruthy();
});

// [G4] Every rule points at an unknown category id → all orphans. They must collapse into a
// SINGLE "Uncategorized" section (not one header per rule) and stay actionable through the
// SectionList. Distinct from the cold-taxonomy test: here categories are loaded, the ids
// just don't resolve.
it('[G4] an orphan-only list renders under exactly one Uncategorized section and stays actionable', () => {
  mockRules = rulesData({ rules: [
    { id: 'o1', pattern: 'GHOSTA', categoryId: 'gone', isNew: false },
    { id: 'o2', pattern: 'GHOSTB', categoryId: 'alsogone', isNew: false },
  ] as Rule[] });
  render(<Rules />);
  expect(screen.getAllByText('Uncategorized')).toHaveLength(1);
  expect(screen.getByText('GHOSTA')).toBeTruthy();
  expect(screen.getByText('GHOSTB')).toBeTruthy();
  fireEvent.press(screen.getByTestId('delete-rule-o2'));
  expect(fns.deleteRule).toHaveBeenCalledWith('o2');
});

// [G5] ListHeaderComponent (intro) + ListFooterComponent (add-rule) render ALONGSIDE the
// ListEmptyComponent — so the intro and "Add a rule" must survive the error, loading and
// no-match states, not just the happy list. A revert that moved intro/footer into the row
// path (only shown when rows exist) would fail this.
it('[G5] intro + add-rule footer render in the error state', () => {
  mockRules = rulesData({ isError: true });
  render(<Rules />);
  expect(screen.getByText('Could not load your rules.')).toBeTruthy();
  expect(screen.getByText(/You have 0 active rules/)).toBeTruthy();
  expect(screen.getByText('Add a rule')).toBeTruthy();
});
it('[G5] intro + add-rule footer render in the loading state', () => {
  mockRules = rulesData({ isLoading: true, rules: [] });
  render(<Rules />);
  expect(screen.getByText('Loading rules…')).toBeTruthy();
  expect(screen.getByText(/You have 0 active rules/)).toBeTruthy();
  expect(screen.getByText('Add a rule')).toBeTruthy();
});
it('[G5] intro + add-rule footer render in the no-match state', () => {
  mockRules = rulesData({ rules: TWO_RULES });
  render(<Rules />);
  fireEvent.changeText(screen.getByLabelText('Search rules'), 'zzznope');
  settle();
  expect(screen.getByText('No rules match “zzznope”.')).toBeTruthy();
  expect(screen.getByText(/You have 2 active rules/)).toBeTruthy();
  expect(screen.getByText('Add a rule')).toBeTruthy();
});

// [G6] Preservation contract: the list must keep taps working while the keyboard is open
// (keyboardShouldPersistTaps="handled") and headers non-sticky. Jest can't open a real
// keyboard, so lock the props on the rendered list AND prove a delete still fires (the
// through-tap the prop protects). Removing the prop drops the match count to 0.
it('[G6] keeps keyboardShouldPersistTaps + non-sticky headers and still deletes through a tap', () => {
  mockRules = rulesData({ rules: TWO_RULES });
  render(<Rules />);
  expect(screen.UNSAFE_queryAllByProps({ keyboardShouldPersistTaps: 'handled' }).length).toBeGreaterThan(0);
  expect(screen.UNSAFE_queryAllByProps({ stickySectionHeadersEnabled: false }).length).toBeGreaterThan(0);
  fireEvent.press(screen.getByTestId('delete-rule-e2'));
  expect(fns.deleteRule).toHaveBeenCalledWith('e2');
});

// [G7] The debounce hook must cancel its pending timer on unmount, or a fake timer leaks
// into the next test (and on device a redraw fires after the screen is gone). getTimerCount
// is 1 while mounted (the pending trailing update) and must drop to 0 after unmount.
it('[G7] unmounting cancels the pending debounce timer (no leak)', () => {
  const { rerender, unmount } = renderHook(
    ({ value }: { value: string }) => useDebouncedValue(value, 250),
    { initialProps: { value: 'a' } },
  );
  rerender({ value: 'b' });
  expect(jest.getTimerCount()).toBeGreaterThan(0); // trailing update pending
  unmount();
  expect(jest.getTimerCount()).toBe(0);            // cleanup cleared it
});
