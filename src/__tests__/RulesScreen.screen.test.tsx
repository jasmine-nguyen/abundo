// Screen test: the Rules screen (WHIT-52 Slice 2). Verifies the loading and
// error+retry states and that a loaded rule renders + its trash button calls
// deleteRule. WHIT-195: the rule list now comes from the cached ['rules'] query, so
// useRulesScreenData is mocked; setSheet/deleteRule/category stay on the store.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act, renderHook } from '@testing-library/react-native';
import type { AppContext, Rule, Category } from '../context';
import type { RulesScreenData } from '../queries';
import { useDebouncedValue } from '../hooks/useDebouncedValue';

// WHIT-192: rules.tsx reads only setSheet + deleteRule off the store; the taxonomy comes
// from useCategories (query layer). The fixture carries those writers PLUS a category()
// lookup purely to feed the mocked useCategories below.
type RulesState = Pick<AppContext, 'setSheet' | 'deleteRule'> & { category: (id: string | null) => Category | undefined };

let mockRules: RulesScreenData;
let mockCategories: Category[];
jest.mock('../queries', () => ({ useRulesScreenData: () => mockRules, useCategories: () => ({ categories: mockCategories, category: mockState.category, isLoading: false, isError: false, refetch: jest.fn(), refetchStale: jest.fn() }) }));

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

const SUBS: Category = { id: 'subs', name: 'Subscriptions', icon: 'film', color: '#f0b27a', bucket: 'Lifestyle', recent: 0 };
const COFFEE: Category = { id: 'coffee', name: 'Cafes & Coffee', icon: 'coffee', color: '#e8a87c', bucket: 'Lifestyle', recent: 0 };

function state(over: Partial<RulesState> = {}): RulesState {
  return {
    category: (id: string | null) => (id === 'subs' ? SUBS : id === 'coffee' ? COFFEE : undefined),
    setSheet: fns.setSheet as AppContext['setSheet'],
    deleteRule: fns.deleteRule as AppContext['deleteRule'],
    ...over,
  };
}

// WHIT-354: the search filter is debounced (250ms), so a filter assertion after
// changeText/clear must first advance the fake clock. settle() does exactly that.
const settle = () => act(() => { jest.advanceTimersByTime(250); });

beforeEach(() => {
  jest.useFakeTimers();
  fns.setSheet.mockClear();
  fns.deleteRule.mockClear();
  fns.refetch.mockClear();
  fns.refetchStale.mockClear();
  mockState = state();
  mockRules = rulesData();
  mockCategories = [SUBS, COFFEE];
});

afterEach(() => {
  jest.useRealTimers();
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

const TWO_RULES = [
  { id: 'e1', pattern: 'NETFLIX', categoryId: 'subs', isNew: false },
  { id: 'e2', pattern: 'STARBUCKS', categoryId: 'coffee', isNew: false },
] as Rule[];

it('groups rules under their category headers', () => {
  mockRules = rulesData({ rules: TWO_RULES });
  render(<Rules />);
  expect(screen.getByText('Subscriptions')).toBeTruthy();
  expect(screen.getByText('Cafes & Coffee')).toBeTruthy();
  expect(screen.getByText('NETFLIX')).toBeTruthy();
  expect(screen.getByText('STARBUCKS')).toBeTruthy();
});

it('typing in the search box filters rows and hides the emptied group', () => {
  mockRules = rulesData({ rules: TWO_RULES });
  render(<Rules />);
  fireEvent.changeText(screen.getByLabelText('Search rules'), 'netflix');
  settle();
  expect(screen.getByText('NETFLIX')).toBeTruthy();
  expect(screen.getByText('Subscriptions')).toBeTruthy();
  // The coffee group and its rule are gone.
  expect(screen.queryByText('STARBUCKS')).toBeNull();
  expect(screen.queryByText('Cafes & Coffee')).toBeNull();
});

it('search matches a category name, keeping a rule whose pattern does not match', () => {
  mockRules = rulesData({ rules: TWO_RULES });
  render(<Rules />);
  fireEvent.changeText(screen.getByLabelText('Search rules'), 'coffee');
  settle();
  // STARBUCKS's pattern has no "coffee", but its category "Cafes & Coffee" does.
  expect(screen.getByText('STARBUCKS')).toBeTruthy();
  expect(screen.getByText('Cafes & Coffee')).toBeTruthy();
  expect(screen.queryByText('NETFLIX')).toBeNull();
});

it('clearing the search restores the full grouped list', () => {
  mockRules = rulesData({ rules: TWO_RULES });
  render(<Rules />);
  const box = screen.getByLabelText('Search rules');
  fireEvent.changeText(box, 'netflix');
  settle();
  expect(screen.queryByText('STARBUCKS')).toBeNull();
  fireEvent.press(screen.getByLabelText('Clear search'));
  settle();
  expect(screen.getByText('STARBUCKS')).toBeTruthy();
  expect(screen.getByText('NETFLIX')).toBeTruthy();
});

it('shows a no-match state when the search matches nothing', () => {
  mockRules = rulesData({ rules: TWO_RULES });
  render(<Rules />);
  fireEvent.changeText(screen.getByLabelText('Search rules'), 'zzznope');
  settle();
  expect(screen.getByText('No rules match “zzznope”.')).toBeTruthy();
  expect(screen.queryByText('NETFLIX')).toBeNull();
  expect(screen.queryByText('STARBUCKS')).toBeNull();
});

// The debounce TIMING contract is owned by useDebouncedValue.screen.test.tsx (a robust
// fail-on-revert guard). A screen-level "still shown at 249ms" assertion is unreliable here:
// under fake timers the SectionList batches its own cell updates, so a row's removal can lag
// a tick regardless of the debounce — the screen can't distinguish the two. The filter tests
// above (type → settle → filtered) cover the wiring; the hook test covers the delay.

it('degrades gracefully when the taxonomy is cold: rules list under Uncategorized and stay actionable', () => {
  mockCategories = []; // categories outage / cold-load
  mockRules = rulesData({ rules: [{ id: 'e1', pattern: 'NETFLIX', categoryId: 'subs', isNew: false }] as Rule[] });
  render(<Rules />);
  expect(screen.getByText('Uncategorized')).toBeTruthy();
  expect(screen.getByText('NETFLIX')).toBeTruthy();
  // still editable + deletable
  fireEvent.press(screen.getByTestId('edit-rule-e1'));
  expect(fns.setSheet).toHaveBeenCalledWith({ mode: 'addrule', ruleId: 'e1' });
  fireEvent.press(screen.getByTestId('delete-rule-e1'));
  expect(fns.deleteRule).toHaveBeenCalledWith('e1');
});

// ===== adversarial gaps (folded in): search-box show/hide, intro count, "Uncategorized" collision =====

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

// ===== WHIT-354 (folded from RulesScreenPerfGaps.screen.test.tsx) =====
// Adversarial GAPS for the Rules screen SectionList/debounce perf change. Mock factories
// (../queries, ../context, ../components/Header, expo-router) are byte-identical to this
// file's and hoist once above; the extra useDebouncedValue import + renderHook cover [G7].

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
