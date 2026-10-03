// Screen test: the Rules screen (WHIT-52 Slice 2). Verifies the loading and
// error+retry states and that a loaded rule renders + its trash button deletes it. Runs over the
// fake server inside the real AppProvider (WHIT-692): the real useRulesScreenData + useCategories
// read the seeded GET /rules + /categories, and the real deleteRule/setSheet run — the server's
// request log shows the DELETE, and the probe shows the toast and the open sheet.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act, renderHook, waitFor } from '@testing-library/react-native';
import type { RuleRecord } from '../api';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient, refreshInAct, settle as settleQueries } from './support/renderWithQueries';
import { renderWithApp, WithApp, shownToasts, currentSheet, resetAppProbe } from './support/renderWithApp';
import { resetAuth } from './support/authMock';
import { queryClient } from '../queryClient';
import { rulesKey } from '../queryKeys';

jest.mock('../auth', () => require('./support/authMock').authMockModule());

// Header pulls in expo-router (a native module that can't load headlessly) and
// isn't under test here — stub it out so the screen renders in jest. The right slot (the "+"
// button) still renders so it can be tapped.
jest.mock('../components/Header', () => ({ Header: ({ right }: { right?: React.ReactNode }) => right ?? null }));
jest.mock('expo-router', () => ({ useFocusEffect: () => {} }));

import Rules from '../../app/rules';

const server = installFakeServer();
useTestQueryClient();

const SUBS = { id: 'subs', name: 'Subscriptions', icon: 'film', color: '#f0b27a', bucket: 'Lifestyle' };
const COFFEE = { id: 'coffee', name: 'Cafes & Coffee', icon: 'coffee', color: '#e8a87c', bucket: 'Lifestyle' };

const rule = (id: string, value: string, categoryId: string): RuleRecord => (
  { id, field: 'description', operator: 'contains', value, categoryId }
);
const NETFLIX = rule('e1', 'NETFLIX', 'subs');
const TWO_RULES = [NETFLIX, rule('e2', 'STARBUCKS', 'coffee')];
const rulesReads = () => server.sent('GET', '/rules');

// WHIT-354: the search filter is debounced (250ms), so a filter assertion after
// changeText/clear must first advance the fake clock. settle() does exactly that.
const settle = () => act(() => { jest.advanceTimersByTime(250); });
function search(text: string) {
  fireEvent.changeText(screen.getByLabelText('Search rules'), text);
  settle();
}

// The query library hands its screen updates over on a timer, which the fake clock holds back:
// run it once the first load has landed. The fake server replies with promises, which fake timers never hold back.
const flush = () => act(async () => { jest.runOnlyPendingTimers(); });
// Tap a rule's trash button, then let the real deleteRule's DELETE and its follow-up reads land.
async function deleteRule(id: string) {
  fireEvent.press(screen.getByTestId(`delete-rule-${id}`));
  await waitFor(() => expect(server.sent('DELETE', `/rules/${id}`)).toHaveLength(1));
  await settleQueries();
  await flush();
}

beforeEach(() => {
  jest.useFakeTimers();
  resetAuth();
  resetAppProbe();
  server.seed('/categories', [SUBS, COFFEE]);
});

afterEach(() => {
  jest.useRealTimers();
});

async function renderHeldRules() {
  const held = server.hold('/rules');
  render(<WithApp><Rules /></WithApp>);
  await waitFor(() => expect(rulesReads()).toHaveLength(1));
  return held;
}

it('shows a loading state while rules load (nothing cached yet)', async () => {
  const held = await renderHeldRules();
  expect(screen.getByText('Loading rules…')).toBeTruthy();
  held.release();
  await settleQueries();
});

it('shows an error with a retry that refetches', async () => {
  server.fail('/rules', 500);
  await renderWithApp(<Rules />);
  expect(screen.getByText('Could not load your rules.')).toBeTruthy();
  // WHIT-198 GAP (authored by qa) — Rules' retry migrated to the shared RetryButton. Pressing by
  // visible text alone would pass for a bare Pressable too, so lock the a11y contract (role +
  // label) a revert would drop. Second migrated screen locked (with Budgets + Transactions).
  const retry = screen.getByTestId('rules-retry');
  expect(retry.props.accessibilityRole).toBe('button');
  expect(retry.props.accessibilityLabel).toBe('Retry loading your rules');
  expect(rulesReads()).toHaveLength(1);
  fireEvent.press(retry);
  await waitFor(() => expect(rulesReads()).toHaveLength(2));
  await settleQueries();
});

it('renders a rule and deletes it via the trash button', async () => {
  server.seed('/rules', [NETFLIX]);
  await renderWithApp(<Rules />);
  expect(screen.getByText('NETFLIX')).toBeTruthy();
  expect(screen.getByText('Subscriptions')).toBeTruthy();
  await deleteRule('e1');
  expect(screen.queryByText('NETFLIX')).toBeNull();
  expect(shownToasts()).toEqual([]);
});

it('a failed delete puts the rule back and toasts', async () => {
  server.seed('/rules', [NETFLIX]);
  server.once('DELETE', '/rules/e1', { status: 500 });
  await renderWithApp(<Rules />);
  await deleteRule('e1');
  expect(screen.getByText('NETFLIX')).toBeTruthy();
  expect(shownToasts()).toEqual(['Could not delete rule. Please try again.']);
});

it('tapping a rule body opens the edit sheet with its id', async () => {
  server.seed('/rules', [NETFLIX]);
  await renderWithApp(<Rules />);
  fireEvent.press(screen.getByTestId('edit-rule-e1'));
  expect(currentSheet()).toEqual({ mode: 'addrule', ruleId: 'e1' });
});

it('the header "+" button opens the add-rule sheet (WHIT-711)', async () => {
  server.seed('/rules', [NETFLIX]);
  await renderWithApp(<Rules />);
  fireEvent.press(screen.getByLabelText('Add rule'));
  expect(currentSheet()).toEqual({ mode: 'addrule' });
});

// A loaded rule is never new (toRule sets isNew:false); only the create writer puts a fresh,
// isNew rule into the ['rules'] cache (context.tsx). Mirror that write, then read the badge.
it('renders the NEW badge on a freshly-created rule (isNew survives the cache mirror)', async () => {
  await renderWithApp(<Rules />);
  expect(screen.queryByText('NEW')).toBeNull();
  await refreshInAct(() => queryClient.setQueryData(rulesKey, [{ id: 'e1', pattern: 'NETFLIX', categoryId: 'subs', isNew: true }]));
  expect(screen.getByText('NETFLIX')).toBeTruthy();
  expect(screen.getByText('NEW')).toBeTruthy();
});

it('groups rules under their category headers', async () => {
  server.seed('/rules', TWO_RULES);
  await renderWithApp(<Rules />);
  expect(screen.getByText('Subscriptions')).toBeTruthy();
  expect(screen.getByText('Cafes & Coffee')).toBeTruthy();
  expect(screen.getByText('NETFLIX')).toBeTruthy();
  expect(screen.getByText('STARBUCKS')).toBeTruthy();
});

it('typing in the search box filters rows and hides the emptied group', async () => {
  server.seed('/rules', TWO_RULES);
  await renderWithApp(<Rules />);
  search('netflix');
  expect(screen.getByText('NETFLIX')).toBeTruthy();
  expect(screen.getByText('Subscriptions')).toBeTruthy();
  // The coffee group and its rule are gone.
  expect(screen.queryByText('STARBUCKS')).toBeNull();
  expect(screen.queryByText('Cafes & Coffee')).toBeNull();
});

it('search matches a category name, keeping a rule whose pattern does not match', async () => {
  server.seed('/rules', TWO_RULES);
  await renderWithApp(<Rules />);
  search('coffee');
  // STARBUCKS's pattern has no "coffee", but its category "Cafes & Coffee" does.
  expect(screen.getByText('STARBUCKS')).toBeTruthy();
  expect(screen.getByText('Cafes & Coffee')).toBeTruthy();
  expect(screen.queryByText('NETFLIX')).toBeNull();
});

it('clearing the search restores the full grouped list', async () => {
  server.seed('/rules', TWO_RULES);
  await renderWithApp(<Rules />);
  search('netflix');
  expect(screen.queryByText('STARBUCKS')).toBeNull();
  fireEvent.press(screen.getByLabelText('Clear search'));
  settle();
  expect(screen.getByText('STARBUCKS')).toBeTruthy();
  expect(screen.getByText('NETFLIX')).toBeTruthy();
});

it('shows a no-match state when the search matches nothing', async () => {
  server.seed('/rules', TWO_RULES);
  await renderWithApp(<Rules />);
  search('zzznope');
  expect(screen.getByText('No rules match “zzznope”.')).toBeTruthy();
  expect(screen.queryByText('NETFLIX')).toBeNull();
  expect(screen.queryByText('STARBUCKS')).toBeNull();
});

// The debounce TIMING contract is owned by useDebouncedValue.screen.test.tsx (a robust
// fail-on-revert guard). A screen-level "still shown at 249ms" assertion is unreliable here:
// under fake timers the SectionList batches its own cell updates, so a row's removal can lag
// a tick regardless of the debounce — the screen can't distinguish the two. The filter tests
// above (type → settle → filtered) cover the wiring; the hook test covers the delay.

it('degrades gracefully when the taxonomy is cold: rules list under Uncategorized and stay actionable', async () => {
  server.fail('/categories', 500); // categories outage
  server.seed('/rules', [NETFLIX]);
  await renderWithApp(<Rules />);
  expect(screen.getByText('Uncategorized')).toBeTruthy();
  expect(screen.getByText('NETFLIX')).toBeTruthy();
  // still editable + deletable
  fireEvent.press(screen.getByTestId('edit-rule-e1'));
  expect(currentSheet()).toEqual({ mode: 'addrule', ruleId: 'e1' });
  await deleteRule('e1');
  expect(screen.queryByText('NETFLIX')).toBeNull();
});

// ===== adversarial gaps (folded in): search-box show/hide, intro count, "Uncategorized" collision =====

// [A24] With zero rules and no query the pinned search box is hidden (nothing to search);
// it must appear once rules exist. Guards the `rules.length > 0 || query.length > 0` gate.
it('[A24] hides the search box when there are no rules, shows it once rules load', async () => {
  await renderWithApp(<Rules />);
  expect(screen.queryByLabelText('Search rules')).toBeNull();

  server.seed('/rules', TWO_RULES);
  await refreshInAct(() => queryClient.refetchQueries({ queryKey: rulesKey }));
  expect(screen.getByLabelText('Search rules')).toBeTruthy();
});

// [A25] The intro line reports the TOTAL rule count and must not shrink when a search
// filters the visible list — it reads `rules` (raw), not the filtered groups.
it('[A25] intro count stays the total (2) even when the filter hides one rule', async () => {
  server.seed('/rules', TWO_RULES);
  await renderWithApp(<Rules />);
  expect(screen.getByText(/You have 2 active rules/)).toBeTruthy();

  search('netflix');
  expect(screen.queryByText('STARBUCKS')).toBeNull(); // list filtered to one
  expect(screen.getByText(/You have 2 active rules/)).toBeTruthy(); // count unchanged
});

// [A26] A user-named "Uncategorized" category plus a genuinely orphaned rule renders TWO
// separate headers with that label — documents the collision the grouping doesn't merge.
it('[A26] renders two "Uncategorized" headers when a real category collides with orphans', async () => {
  server.seed('/categories', [{ id: 'real', name: 'Uncategorized', icon: 'tag', color: '#abc', bucket: 'Lifestyle' }]);
  server.seed('/rules', [rule('r1', 'REALONE', 'real'), rule('r2', 'GHOST', 'deleted')]);
  await renderWithApp(<Rules />);
  expect(screen.getAllByText('Uncategorized')).toHaveLength(2);
  expect(screen.getByText('REALONE')).toBeTruthy();
  expect(screen.getByText('GHOST')).toBeTruthy();
});

// ===== WHIT-354 (folded from RulesScreenPerfGaps.screen.test.tsx) =====
// Adversarial GAPS for the Rules screen SectionList/debounce perf change. The extra
// useDebouncedValue import + renderHook cover [G7].

// [G1] Smoke test for the SectionList swap on a large list: the top of the list stays usable
// — first row, its section header, the intro header and the add-rule footer all render. (This
// asserts presence of the top, not virtualization itself — RNTL has no viewport to window
// against, so it can't prove off-screen rows are skipped; that's a device check, [M1]/[M2].)
it('[G1] a large (60-rule) list still renders the first row, its header, the intro and the footer', async () => {
  server.seed('/rules', Array.from({ length: 60 }, (_, i) => rule(`e${i}`, `RULE${i}`, 'subs')));
  await renderWithApp(<Rules />);
  expect(screen.getByTestId('edit-rule-e0')).toBeTruthy();
  expect(screen.getByText('Subscriptions')).toBeTruthy();
  expect(screen.getByText(/You have 60 active rules/)).toBeTruthy();
  expect(screen.getByText('Add a rule')).toBeTruthy();
});

// [G4] Every rule points at an unknown category id → all orphans. They must collapse into a
// SINGLE "Uncategorized" section (not one header per rule) and stay actionable through the
// SectionList. Distinct from the cold-taxonomy test: here categories are loaded, the ids
// just don't resolve.
it('[G4] an orphan-only list renders under exactly one Uncategorized section and stays actionable', async () => {
  server.seed('/rules', [rule('o1', 'GHOSTA', 'gone'), rule('o2', 'GHOSTB', 'alsogone')]);
  await renderWithApp(<Rules />);
  expect(screen.getAllByText('Uncategorized')).toHaveLength(1);
  expect(screen.getByText('GHOSTA')).toBeTruthy();
  expect(screen.getByText('GHOSTB')).toBeTruthy();
  await deleteRule('o2');
  expect(screen.queryByText('GHOSTB')).toBeNull();
  expect(screen.getByText('GHOSTA')).toBeTruthy();
});

// [G5] ListHeaderComponent (intro) + ListFooterComponent (add-rule) render ALONGSIDE the
// ListEmptyComponent — so the intro and "Add a rule" must survive the error, loading and
// no-match states, not just the happy list. A revert that moved intro/footer into the row
// path (only shown when rows exist) would fail this.
it('[G5] intro + add-rule footer render in the error state', async () => {
  server.fail('/rules', 500);
  await renderWithApp(<Rules />);
  expect(screen.getByText('Could not load your rules.')).toBeTruthy();
  expect(screen.getByText(/You have 0 active rules/)).toBeTruthy();
  expect(screen.getByText('Add a rule')).toBeTruthy();
});
it('[G5] intro + add-rule footer render in the loading state', async () => {
  const held = await renderHeldRules();
  expect(screen.getByText('Loading rules…')).toBeTruthy();
  expect(screen.getByText(/You have 0 active rules/)).toBeTruthy();
  expect(screen.getByText('Add a rule')).toBeTruthy();
  held.release();
  await settleQueries();
});
it('[G5] intro + add-rule footer render in the no-match state', async () => {
  server.seed('/rules', TWO_RULES);
  await renderWithApp(<Rules />);
  search('zzznope');
  expect(screen.getByText('No rules match “zzznope”.')).toBeTruthy();
  expect(screen.getByText(/You have 2 active rules/)).toBeTruthy();
  expect(screen.getByText('Add a rule')).toBeTruthy();
});

// [G6] Preservation contract: the list must keep taps working while the keyboard is open
// (keyboardShouldPersistTaps="handled") and headers non-sticky. Jest can't open a real
// keyboard, so lock the props on the rendered list AND prove a delete still fires (the
// through-tap the prop protects). Removing the prop drops the match count to 0.
it('[G6] keeps keyboardShouldPersistTaps + non-sticky headers and still deletes through a tap', async () => {
  server.seed('/rules', TWO_RULES);
  await renderWithApp(<Rules />);
  expect(screen.UNSAFE_queryAllByProps({ keyboardShouldPersistTaps: 'handled' }).length).toBeGreaterThan(0);
  expect(screen.UNSAFE_queryAllByProps({ stickySectionHeadersEnabled: false }).length).toBeGreaterThan(0);
  await deleteRule('e2');
  expect(screen.queryByText('STARBUCKS')).toBeNull();
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
