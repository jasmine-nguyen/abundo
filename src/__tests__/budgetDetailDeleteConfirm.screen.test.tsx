// WHIT-708 — "Delete budget" asks first. Pressing it opens a native confirm; only the
// destructive "Delete" removes the budget and goes back, "Cancel" does nothing.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { screen, fireEvent, act, waitFor } from '@testing-library/react-native';

const mockBack = jest.fn();
const mockDeleteBudget = jest.fn(async (_id: string) => true);

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ deleteBudget: mockDeleteBudget, openPicker: jest.fn() }) };
});
jest.mock('../auth', () => require('./support/authMock').authMockModule());

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: mockBack }),
  useLocalSearchParams: () => ({ id: 'coffee' }),
}));

import BudgetDetail from '../../app/budget/[id]';
import { resetAuth } from './support/authMock';
import { spyOnAlert } from './support/alertSpy';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';

const server = installFakeServer();
useTestQueryClient();
const alerts = spyOnAlert();

beforeEach(() => {
  resetAuth();
  mockBack.mockClear();
  mockDeleteBudget.mockClear();
  mockDeleteBudget.mockResolvedValue(true);
  server.seed('/categories', [{ id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 0 }]);
  server.seed('/budgets', { coffee: { target: 100, posted: 40, pending: 10 } });
  server.seed('/budgets/coffee/transactions', []);
  server.seed('/paycycle', { length: 30, last_pay_date: '2026-07-01', days_left: 12 });
});

function openConfirm() {
  fireEvent.press(screen.getByText('Delete budget'));
  expect(alerts.spy).toHaveBeenCalledTimes(1);
  return alerts.last();
}

it('user must confirm before a budget is deleted; Delete removes it once and goes back', async () => {
  await renderWithQueries(<BudgetDetail />);

  const { title, button } = openConfirm();

  expect(title).toBe('Delete this budget?');
  expect(mockDeleteBudget).not.toHaveBeenCalled();
  expect(button('Delete').style).toBe('destructive');

  await act(async () => { await button('Delete').onPress!(); });

  expect(mockDeleteBudget).toHaveBeenCalledTimes(1);
  expect(mockDeleteBudget).toHaveBeenCalledWith('coffee');
  await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
});

it('user can cancel the confirm and the budget is kept', async () => {
  await renderWithQueries(<BudgetDetail />);

  const { button } = openConfirm();
  const cancel = button('Cancel');
  expect(cancel.style).toBe('cancel');
  await act(async () => { await cancel.onPress?.(); });

  expect(mockDeleteBudget).not.toHaveBeenCalled();
  expect(mockBack).not.toHaveBeenCalled();
  expect(screen.getByText('Delete budget')).toBeTruthy();
});
