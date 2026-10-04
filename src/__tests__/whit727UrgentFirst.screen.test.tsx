// WHIT-727 — on the Budgets tab, an over-budget row shows above an on-pace row that comes
// before it in category order. Real ../api over the fake server; ../auth + expo-router mocked.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { screen } from '@testing-library/react-native';
import { resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { pinToday } from './support/clock';
import { seedBudgetsTab } from './support/budgetsTab';
import { COFFEE, DINING } from './support/categories';

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ deleteBudget: jest.fn(), openPicker: jest.fn() }) };
});
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Budgets from '../../app/(tabs)/budgets';
import { resetAuth } from './support/authMock';

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  resetRouter();
  resetAuth();
  pinToday(new Date('2026-10-03T10:00:00+10:00'));
});
afterEach(() => {
  jest.useRealTimers();
});

it('shows the over-budget row before an on-pace row listed ahead of it', async () => {
  // 7 of 14 days left → pace is half the budget: coffee $50 of $100 is on pace, dining $150 of $100 is over.
  seedBudgetsTab(
    server,
    {
      coffee: { target: 100, posted: 50, pending: 0 },
      dining: { target: 100, posted: 150, pending: 0 },
    },
    [COFFEE, DINING],
  );
  await renderWithQueries(<Budgets />);
  await screen.findByText('Dining');
  const order = screen.getAllByText(/^(Cafes & Coffee|Dining)$/).map((n) => n.props.children);
  expect(order).toEqual(['Dining', 'Cafes & Coffee']);
});
