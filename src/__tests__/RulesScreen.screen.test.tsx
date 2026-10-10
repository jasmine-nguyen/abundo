// Screen test: the Rules screen (WHIT-52 Slice 2). Verifies the
// error+retry state and that a loaded rule renders + its trash button deletes it. Runs over the
// fake server inside the real AppProvider (WHIT-692): the real useRulesScreenData + useCategories
// read the seeded GET /rules + /categories, and the real deleteRule/setSheet run — the server's
// request log shows the DELETE, and the probe shows the toast and the open sheet.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import type { RuleRecord } from '../api';
import { installFakeServer } from './support/fakeServer';
import { COFFEE_RECORD, SUBSCRIPTIONS } from './support/categories';
import { useTestQueryClient, refreshInAct, settle as settleQueries } from './support/renderWithQueries';
import { renderWithApp, shownToasts, currentSheet, resetAppProbe } from './support/renderWithApp';
import { resetAuth } from './support/authMock';
import { queryClient } from '../queryClient';
import { rulesKey } from '../queryKeys';
import { fireFocus } from './support/routerMock';

jest.mock('../auth', () => require('./support/authMock').authMockModule());

// Header pulls in expo-router (a native module that can't load headlessly) and
// isn't under test here — stub it out so the screen renders in jest. The right slot (the "+"
// button) still renders so it can be tapped.
jest.mock('../components/Header', () => ({ Header: ({ right }: { right?: React.ReactNode }) => right ?? null }));
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Rules from '../../app/rules';

const server = installFakeServer();
useTestQueryClient();

const COFFEE = { ...COFFEE_RECORD, color: '#e8a87c' };

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
  server.seed('/categories', [SUBSCRIPTIONS, COFFEE]);
});

afterEach(() => {
  jest.useRealTimers();
});

it('shows an error with a retry that refetches', async () => {
  server.fail('/rules', 500);
  await renderWithApp(<Rules />);
  expect(screen.getByText('Could not load your rules.')).toBeTruthy();
  // Pressing by visible text alone would pass for a bare Pressable too, so lock the button role.
  const retry = screen.getByTestId('rules-retry');
  expect(retry.props.accessibilityRole).toBe('button');
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

// WHIT-753 QA [A1] — the shared router fake runs the screen's focus refresh (the old no-op
// useFocusEffect never did). A later focus on stale rules must re-read /rules. Fail-on-revert:
// drop the useFocusEffect line from app/rules.tsx and no second read is sent.
it('[A1] a later focus re-reads the rules once they are stale', async () => {
  server.seed('/rules', [NETFLIX]);
  await renderWithApp(<Rules />);
  expect(rulesReads()).toHaveLength(1);
  await refreshInAct(() => queryClient.invalidateQueries({ queryKey: rulesKey, refetchType: 'none' }));

  await refreshInAct(() => fireFocus());
  await settleQueries();

  expect(rulesReads()).toHaveLength(2);
});
