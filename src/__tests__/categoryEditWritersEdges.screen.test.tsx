// WHIT-692 QA: edges of the category edit screen's real create, update and delete writers over the
// fake server — sign-out mid-delete, same-frame double taps, parent-before-children ordering, a
// delete refused with a reason, and the exact body a new inline sub-category sends.
import { it, expect, jest, beforeEach, describe } from '@jest/globals';
import { routerSpies, setParams, resetRouter } from './support/routerMock';
import React from 'react';
import { screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import type { Category } from '../types';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient, refreshInAct } from './support/renderWithQueries';
import { renderWithApp, shownToasts, resetAppProbe } from './support/renderWithApp';
import { resetAuth, setAuthStatus } from './support/authMock';

jest.mock('../auth', () => require('./support/authMock').authMockModule());

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import CategoryEdit from '../../app/category/edit';

const server = installFakeServer();
useTestQueryClient();

const LIVING = (id: string, name: string, parent: string | null = null): Category =>
  ({ id, name, bucket: 'Living', icon: 'car', color: '#8ab4f8', parent });

async function drawEdit(categories: Category[]) {
  server.seed('/categories', categories);
  await renderWithApp(<CategoryEdit />);
  await refreshInAct(() => undefined);
}

beforeEach(() => {
  resetRouter();
  resetAuth();
  resetAppProbe();
  setParams({});
});

describe('deleting a category when the session changes mid-delete', () => {
  beforeEach(() => { setParams({ categoryId: 'coffee' }); });

  // [A1] The DELETE is held, the user signs out, then the server refuses. Nothing may reach the
  // next session: no failure toast, no navigation.
  it('a sign-out during a failing delete shows no toast and does not navigate', async () => {
    await drawEdit([LIVING('coffee', 'Coffee')]);
    const held = server.hold('/categories/coffee');

    await act(async () => { fireEvent.press(screen.getByText('Delete category')); });
    act(() => setAuthStatus('anon'));
    await act(async () => { held.fail('DELETE', { status: 500 }); });

    expect(server.sent('DELETE', '/categories/coffee')).toHaveLength(1);
    expect(shownToasts()).toEqual([]);
    expect(routerSpies.back).not.toHaveBeenCalled();
  });

  // [A2] Same, but the server then says the delete worked. The real writer returns false after a
  // sign-out, so the screen must not toast "Category deleted." or go back into the next session.
  it('a sign-out during a successful delete shows no toast and does not navigate', async () => {
    await drawEdit([LIVING('coffee', 'Coffee')]);
    const held = server.hold('/categories/coffee');

    await act(async () => { fireEvent.press(screen.getByText('Delete category')); });
    act(() => setAuthStatus('anon'));
    await act(async () => { held.release(); });

    expect(server.sent('DELETE', '/categories/coffee')).toHaveLength(1);
    expect(shownToasts()).toEqual([]);
    expect(routerSpies.back).not.toHaveBeenCalled();
  });
});

describe('a delete refused with a reason', () => {
  // [A3] The server's own words replace the generic line, and the screen stays put.
  it('shows the server reason as the one toast and stays on the screen', async () => {
    setParams({ categoryId: 'coffee' });
    server.once('DELETE', '/categories/coffee', { status: 409, reason: 'category is used by a budget' });
    await drawEdit([LIVING('coffee', 'Coffee')]);

    await act(async () => { fireEvent.press(screen.getByText('Delete category')); });

    await waitFor(() => expect(shownToasts()).toEqual(['Category is used by a budget.']));
    expect(routerSpies.back).not.toHaveBeenCalled();
  });
});

describe('same-frame double taps send once', () => {
  // [A4] Two Save taps in one frame (before `submitting` can redraw) → exactly one PATCH.
  it('two Save taps in one frame send one update', async () => {
    setParams({ categoryId: 'transport' });
    await drawEdit([LIVING('transport', 'Transport')]);

    await act(async () => {
      fireEvent.press(screen.getByText('Save category'));
      fireEvent.press(screen.getByText('Save category'));
    });

    await waitFor(() => expect(routerSpies.back).toHaveBeenCalledTimes(1));
    expect(server.sent('PATCH', '/categories/transport')).toHaveLength(1);
    expect(shownToasts()).toEqual(['Category updated.']);
  });

  // [A5] Two Delete taps in one frame → exactly one DELETE.
  it('two Delete taps in one frame send one delete', async () => {
    setParams({ categoryId: 'coffee' });
    await drawEdit([LIVING('coffee', 'Coffee')]);

    await act(async () => {
      fireEvent.press(screen.getByText('Delete category'));
      fireEvent.press(screen.getByText('Delete category'));
    });

    await waitFor(() => expect(routerSpies.back).toHaveBeenCalledTimes(1));
    expect(server.sent('DELETE', '/categories/coffee')).toHaveLength(1);
    expect(shownToasts()).toEqual(['Category deleted.']);
  });
});

describe('the parent is saved before its children', () => {
  // [A6] While the parent's own update is still waiting on the server, no child attach is sent.
  // The children only go once the parent has been saved.
  it('sends no child attach until the parent update has answered', async () => {
    setParams({ categoryId: 'transport' });
    await drawEdit([LIVING('transport', 'Transport'), LIVING('parking', 'Parking')]);
    fireEvent.press(screen.getByTestId('attachChild-parking'));
    const held = server.hold('/categories/transport');

    await act(async () => { fireEvent.press(screen.getByText('Save category')); });
    await waitFor(() => expect(server.sent('PATCH', '/categories/transport')).toHaveLength(1));
    expect(server.sent('PATCH', '/categories/parking')).toEqual([]);

    await act(async () => { held.release(); });
    await waitFor(() => expect(routerSpies.back).toHaveBeenCalledTimes(1));
    expect(server.sent('PATCH', '/categories/parking').map((request) => request.body)).toEqual([
      { name: 'Parking', bucket: 'Living', icon: 'car', parent: 'transport' }]);
  });
});

describe('a new inline sub-category', () => {
  // [A7] The full create body — name, the parent's bucket, its own icon and the parent id. The
  // big suite only checks part of it.
  it('sends its full body under the edited parent', async () => {
    setParams({ categoryId: 'transport' });
    await drawEdit([LIVING('transport', 'Transport')]);
    fireEvent.press(screen.getByText('＋ New sub-category'));
    fireEvent.changeText(screen.getByPlaceholderText('Category name'), '  Tolls  ');
    fireEvent.press(screen.getByText('Add sub-category'));

    await act(async () => { fireEvent.press(screen.getByText('Save category')); });

    await waitFor(() => expect(shownToasts()).toEqual(['Category updated, with 1 sub-category.']));
    const bodies = server.sent('POST', '/categories').map((request) => request.body);
    expect(bodies).toEqual([{ name: 'Tolls', bucket: 'Living', icon: expect.any(String), parent: 'transport' }]);
    expect((bodies[0] as { icon: string }).icon.length).toBeGreaterThan(0);
  });
});
