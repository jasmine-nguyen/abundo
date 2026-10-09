// WHIT-688 fix round QA — the cold-open re-seed fix in app/category/edit.tsx: the seed now checks
// the parent against the category's OWN bucket and the "keep the parent valid" effect skips once.
// These pin the two halves the skip could hide: a bad legacy parent is still dropped, and the
// validity check still runs on later bucket changes. The screen draws inside the real AppProvider
// (WHIT-692), so Save runs the real saveCategory and the fake server shows the PATCH body.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { screen, fireEvent, waitFor } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient, refreshInAct } from './support/renderWithQueries';
import { renderWithApp, resetAppProbe } from './support/renderWithApp';
import { resetAuth } from './support/authMock';
import { setParams, resetRouter } from './support/routerMock';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import CategoryEdit from '../../app/category/edit';

const server = installFakeServer();
useTestQueryClient();

// Cold open: the form mounts before the list lands, so the late re-seed fills it.
async function coldOpen(categoryId: string) {
  setParams({ categoryId });
  await renderWithApp(<CategoryEdit />);
}

async function saveAndExpect(body: object) {
  fireEvent.press(screen.getByText('Save category'));
  await waitFor(() => expect(server.sent('PATCH', '/categories/parking')).toHaveLength(1));
  expect(server.sent('PATCH', '/categories/parking')[0].body).toEqual(body);
}

beforeEach(() => {
  resetAuth();
  resetRouter();
  resetAppProbe();
});

describe('category edit: cold-open re-seed', () => {
  // [A11] (P0) A legacy cross-bucket link (Lifestyle sub under a Living parent) must still be dropped
  // on a cold open. The sub's bucket equals the form default, so the bucket never changes and the
  // validity effect (which skips the seed pass) never re-runs — only the seed's own check drops it.
  // Fail-on-revert: seed `setParent(existing.parent ?? null)` unchecked → saves parent 'transport'.
  it('drops a parent from a different bucket on a cold open', async () => {
    server.seed('/categories', [
      { id: 'parking', name: 'Parking', bucket: 'Lifestyle', icon: 'car', parent: 'transport' },
      { id: 'transport', name: 'Transport', bucket: 'Living', icon: 'car', parent: null },
    ]);
    await coldOpen('parking');
    expect(screen.getByDisplayValue('Parking')).toBeTruthy();
    await saveAndExpect({ name: 'Parking', bucket: 'Lifestyle', icon: 'car', parent: null });
  });

  // [A12] (P0) After the seed, switching bucket still clears a parent from the old bucket.
  // Fail-on-revert: make the validity effect always skip (or never reset the flag) → parent kept.
  it('still drops the parent when the user switches bucket after a cold open', async () => {
    server.seed('/categories', [
      { id: 'parking', name: 'Parking', bucket: 'Living', icon: 'car', parent: 'transport' },
      { id: 'transport', name: 'Transport', bucket: 'Living', icon: 'car', parent: null },
    ]);
    await coldOpen('parking');
    expect(screen.getByDisplayValue('Parking')).toBeTruthy();
    fireEvent.press(screen.getByText('Lifestyle'));
    await refreshInAct(() => undefined);
    await saveAndExpect({ name: 'Parking', bucket: 'Lifestyle', icon: 'car', parent: null });
  });

  // [A13] (P1) Regression: a Lifestyle sub (same bucket as the form default) keeps its parent on a
  // cold open — the seed pass's skip must not leave a stale state either way.
  it('keeps a Lifestyle sub-category under its parent on a cold open', async () => {
    server.seed('/categories', [
      { id: 'parking', name: 'Parking', bucket: 'Lifestyle', icon: 'car', parent: 'fun' },
      { id: 'fun', name: 'Fun', bucket: 'Lifestyle', icon: 'coffee', parent: null },
    ]);
    await coldOpen('parking');
    expect(screen.getByDisplayValue('Parking')).toBeTruthy();
    await saveAndExpect({ name: 'Parking', bucket: 'Lifestyle', icon: 'car', parent: 'fun' });
  });
});
