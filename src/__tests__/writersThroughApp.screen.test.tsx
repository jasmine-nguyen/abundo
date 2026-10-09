// WHIT-692 slice 1 acceptance — save and delete buttons run the REAL app writers (no
// useAppContext stub) and reach the fake server. The screen is drawn inside the real AppProvider via
// renderWithApp; the server's request log shows what was sent, and the probe shows the toast.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { screen, fireEvent, waitFor } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { SUBSCRIPTIONS } from './support/categories';
import { useTestQueryClient } from './support/renderWithQueries';
import { renderWithApp, shownToasts, resetAppProbe } from './support/renderWithApp';
import { resetAuth } from './support/authMock';
import { setParams, resetRouter } from './support/routerMock';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());
jest.mock('../components/Header', () => ({ Header: () => null }));

import Rules from '../../app/rules';
import CategoryEdit from '../../app/category/edit';

const server = installFakeServer();
useTestQueryClient();

const NETFLIX = { id: 'e1', field: 'description', operator: 'contains', value: 'NETFLIX', categoryId: 'subs' };

beforeEach(() => {
  resetAuth();
  resetRouter();
  resetAppProbe();
});

it('user taps a rule\'s trash button → the real app sends DELETE /rules/e1, and on a server error the rule comes back with a toast', async () => {
  server.seed('/categories', [SUBSCRIPTIONS]);
  server.seed('/rules', [NETFLIX]);
  server.once('DELETE', '/rules/e1', { status: 500 });
  await renderWithApp(<Rules />);
  expect(screen.getByText('NETFLIX')).toBeTruthy();

  fireEvent.press(screen.getByTestId('delete-rule-e1'));

  await waitFor(() => expect(server.sent('DELETE', '/rules/e1')).toHaveLength(1));
  await waitFor(() => expect(shownToasts()).toEqual(['Could not delete rule. Please try again.']));
  expect(screen.getByText('NETFLIX')).toBeTruthy();
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
