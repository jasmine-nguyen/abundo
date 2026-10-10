// WHIT-692 slice 1 — save and delete buttons run the REAL app writers (no useAppContext stub) and
// reach the fake server. The screen is drawn inside the real AppProvider via renderWithApp; the
// server's request log shows what was sent, and the probe shows the toast. Also: rule-delete
// rollback order, a sign-out mid-delete, a blocked save sending nothing, and a real save's toast.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { screen, fireEvent, waitFor, act } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { SUBSCRIPTIONS } from './support/categories';
import { useTestQueryClient, refreshInAct } from './support/renderWithQueries';
import { renderWithApp, shownToasts, resetAppProbe } from './support/renderWithApp';
import { resetAuth, setAuthStatus } from './support/authMock';
import { setParams, resetRouter, routerSpies } from './support/routerMock';
import { queryClient } from '../queryClient';
import { rulesKey } from '../queryKeys';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());
jest.mock('../components/Header', () => ({ Header: () => null }));

import Rules from '../../app/rules';
import CategoryEdit from '../../app/category/edit';

const server = installFakeServer();
useTestQueryClient();

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

it('user saves an edited category → the real app sends PATCH /categories/parking with the form as the body', async () => {
  server.seed('/categories', [
    { id: 'parking', name: 'Parking', bucket: 'Lifestyle', icon: 'car', parent: 'fun' },
    { id: 'fun', name: 'Fun', bucket: 'Lifestyle', icon: 'coffee', parent: null },
  ]);
  setParams({ categoryId: 'parking' });
  await renderWithApp(<CategoryEdit />);
  await waitFor(() => expect(screen.getByDisplayValue('Parking')).toBeTruthy());

  fireEvent.changeText(screen.getByDisplayValue('Parking'), 'Car parks');
  fireEvent.press(screen.getByText('Save category'));

  await waitFor(() => expect(server.sent('PATCH', '/categories/parking')).toHaveLength(1));
  expect(server.sent('PATCH', '/categories/parking')[0].body).toEqual(
    { name: 'Car parks', bucket: 'Lifestyle', icon: 'car', parent: 'fun' },
  );
});

describe('Rules delete through the real deleteRule', () => {
  beforeEach(() => server.seed('/categories', [SUBSCRIPTIONS]));

  // [A2] a failed delete of a MIDDLE rule puts it back in its old place, not at the end.
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

  // [A4] signing out while the DELETE is in flight: the failure must not toast or put the rule back
  // into the next session's list.
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
});

describe('Category edit save through the real saveCategory', () => {
  const CATEGORIES = [
    { id: 'coffee', name: 'Coffee', bucket: 'Lifestyle', icon: 'coffee', parent: null },
  ];

  async function drawEdit() {
    setParams({ categoryId: 'coffee' });
    await renderWithApp(<CategoryEdit />);
  }

  // [A6] a blocked save (the list failed to load) sends NO write at all — not a PATCH, and not a
  // POST either (treating the edit as a create would write a duplicate category).
  it('[A6] a save blocked by a failed category list sends no write of any kind', async () => {
    server.fail('/categories', 500);
    await drawEdit();
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Coffee runs'), 'Renamed');
    fireEvent.press(screen.getByText('Save category'));
    await refreshInAct(() => undefined);
    expect(nonGets()).toEqual([]);
    expect(routerSpies.back).not.toHaveBeenCalled();
  });

  // [A7] success: exactly one summary toast, then the screen closes.
  it('[A7] a successful save toasts "Category updated." once and goes back', async () => {
    server.seed('/categories', CATEGORIES);
    await drawEdit();
    fireEvent.changeText(screen.getByDisplayValue('Coffee'), 'Cafes');
    fireEvent.press(screen.getByText('Save category'));
    await waitFor(() => expect(routerSpies.back).toHaveBeenCalledTimes(1));
    expect(shownToasts()).toEqual(['Category updated.']);
    expect(server.sent('PATCH', '/categories/coffee')).toHaveLength(1);
  });
});
