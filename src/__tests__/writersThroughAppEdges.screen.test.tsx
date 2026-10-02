// WHIT-692 slice 1 QA — edges of the save/delete taps now that they run the REAL writers inside the
// real AppProvider (support/renderWithApp) over the fake server: rule-delete rollback order, the
// skipped rules refetch, a sign-out mid-delete, a blocked save sending nothing at all, and what the
// user sees (toast + navigation) after a real category save succeeds or fails.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { screen, fireEvent, waitFor, act } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient, refreshInAct } from './support/renderWithQueries';
import { renderWithApp, shownToasts, currentSheet, resetAppProbe } from './support/renderWithApp';
import { resetAuth, setAuthStatus } from './support/authMock';
import { setParams, resetRouter, routerSpies } from './support/routerMock';
import { queryClient } from '../queryClient';
import { rulesKey } from '../queryKeys';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());
jest.mock('../components/Header', () => ({ Header: () => null }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import Rules from '../../app/rules';
import CategoryEdit from '../../app/category/edit';

const server = installFakeServer();
useTestQueryClient();

const SUBS = { id: 'subs', name: 'Subscriptions', icon: 'film', color: '#f0b27a', bucket: 'Lifestyle' };
const rule = (id: string, value: string) => ({ id, field: 'description', operator: 'contains', value, categoryId: 'subs' });
const NETFLIX = rule('e1', 'NETFLIX');
const SPOTIFY = rule('e2', 'SPOTIFY');
const HULU = rule('e3', 'HULU');

const cachedRuleIds = () => (queryClient.getQueryData<{ id: string }[]>(rulesKey) ?? []).map((r) => r.id);

const nonGets = () => server.requests().filter((request) => request.method !== 'GET');

beforeEach(() => {
  resetAuth();
  resetRouter();
  resetAppProbe();
});

describe('Rules delete through the real deleteRule', () => {
  beforeEach(() => server.seed('/categories', [SUBS]));

  // [A1] (P0) success: one DELETE, the row is gone, no toast, and the rules list is NOT re-read
  // (skipRules — a re-read would race the optimistic removal).
  it('[A1] a successful delete sends one DELETE, drops the row, and does not re-read /rules', async () => {
    server.seed('/rules', [NETFLIX, SPOTIFY]);
    await renderWithApp(<Rules />);
    const rulesReads = server.sent('GET', '/rules').length;

    fireEvent.press(screen.getByTestId('delete-rule-e1'));
    await waitFor(() => expect(server.sent('DELETE', '/rules/e1')).toHaveLength(1));
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));

    expect(screen.queryByText('NETFLIX')).toBeNull();
    expect(screen.getByText('SPOTIFY')).toBeTruthy();
    expect(server.sent('GET', '/rules')).toHaveLength(rulesReads);
    expect(shownToasts()).toEqual([]);
  });

  // [A2] (P0) a failed delete of a MIDDLE rule puts it back in its old place, not at the end.
  it('[A2] a failed delete puts the rule back in its original position', async () => {
    server.seed('/rules', [NETFLIX, SPOTIFY, HULU]);
    server.once('DELETE', '/rules/e2', { status: 500 });
    await renderWithApp(<Rules />);
    expect(cachedRuleIds()).toEqual(['e1', 'e2', 'e3']);

    fireEvent.press(screen.getByTestId('delete-rule-e2'));
    await waitFor(() => expect(shownToasts()).toEqual(['Could not delete rule. Please try again.']));

    expect(cachedRuleIds()).toEqual(['e1', 'e2', 'e3']);
    expect(screen.getByText('SPOTIFY')).toBeTruthy();
  });

  // [A3] (P1) a lost connection is a failure too: the row comes back with the same toast.
  it('[A3] a dropped connection on delete restores the row and toasts', async () => {
    server.seed('/rules', [NETFLIX]);
    server.once('DELETE', '/rules/e1', 'dropped');
    await renderWithApp(<Rules />);

    fireEvent.press(screen.getByTestId('delete-rule-e1'));
    await waitFor(() => expect(shownToasts()).toEqual(['Could not delete rule. Please try again.']));
    expect(screen.getByText('NETFLIX')).toBeTruthy();
  });

  // [A4] (P1) signing out while the DELETE is in flight: the failure must not toast or put the
  // rule back into the next session's list.
  it('[A4] a sign-out mid-delete shows no toast and does not restore the rule', async () => {
    server.seed('/rules', [NETFLIX]);
    await renderWithApp(<Rules />);
    const held = server.hold('/rules/e1');

    fireEvent.press(screen.getByTestId('delete-rule-e1'));
    await waitFor(() => expect(server.sent('DELETE', '/rules/e1')).toHaveLength(1));
    act(() => setAuthStatus('anon'));
    await act(async () => { held.fail('DELETE', { status: 500 }); });
    await act(async () => { await Promise.resolve(); });

    expect(shownToasts()).toEqual([]);
    expect(cachedRuleIds()).not.toContain('e1');
  });

  // [A5] (P1) the "Add a rule" footer opens the real add-rule sheet with no rule id.
  it('[A5] the Add a rule footer opens the add-rule sheet', async () => {
    server.seed('/rules', [NETFLIX]);
    await renderWithApp(<Rules />);
    fireEvent.press(screen.getByText('Add a rule'));
    expect(currentSheet()).toEqual({ mode: 'addrule' });
  });
});

describe('Category edit save through the real saveCategory', () => {
  const CATEGORIES = [
    { id: 'coffee', name: 'Coffee', bucket: 'Lifestyle', icon: 'coffee', parent: null },
  ];

  async function drawEdit() {
    setParams({ categoryId: 'coffee' });
    await renderWithApp(<CategoryEdit />);
    await refreshInAct(() => undefined);
  }

  // [A6] (P0) a blocked save (the list failed to load) sends NO write at all — not a PATCH, and
  // not a POST either (treating the edit as a create would write a duplicate category).
  it('[A6] a save blocked by a failed category list sends no write of any kind', async () => {
    server.fail('/categories', 500);
    await drawEdit();
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Coffee runs'), 'Renamed');
    fireEvent.press(screen.getByText('Save category'));
    await refreshInAct(() => undefined);
    expect(nonGets()).toEqual([]);
    expect(routerSpies.back).not.toHaveBeenCalled();
  });

  // [A7] (P0) success: exactly one summary toast, then the screen closes.
  it('[A7] a successful save toasts "Category updated." once and goes back', async () => {
    server.seed('/categories', CATEGORIES);
    await drawEdit();
    fireEvent.changeText(screen.getByDisplayValue('Coffee'), 'Cafes');
    fireEvent.press(screen.getByText('Save category'));
    await waitFor(() => expect(routerSpies.back).toHaveBeenCalledTimes(1));
    expect(shownToasts()).toEqual(['Category updated.']);
    expect(server.sent('PATCH', '/categories/coffee')).toHaveLength(1);
  });

  // [A8] (P1) the server refuses with a reason: the user sees the server's words, stays on the
  // screen, and the refusal is handled (nothing escapes to console.error).
  it('[A8] a 400 with a reason toasts the reason and stays on the screen', async () => {
    server.seed('/categories', CATEGORIES);
    server.once('PATCH', '/categories/coffee', { status: 400, reason: 'name already taken' });
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await drawEdit();
      fireEvent.press(screen.getByText('Save category'));
      await waitFor(() => expect(shownToasts()).toEqual(['Name already taken.']));
      expect(routerSpies.back).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
      expect(screen.getByText('Save category')).toBeTruthy();
    } finally {
      errors.mockRestore();
    }
  });

  // [A9] (P1) a plain server error: the generic toast, still on the screen.
  it('[A9] a 500 on save toasts the generic failure and stays on the screen', async () => {
    server.seed('/categories', CATEGORIES);
    server.once('PATCH', '/categories/coffee', { status: 500 });
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await drawEdit();
      fireEvent.press(screen.getByText('Save category'));
      await waitFor(() => expect(shownToasts()).toEqual(['Could not save category. Please try again.']));
      expect(routerSpies.back).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});
