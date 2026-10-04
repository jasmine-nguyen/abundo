// WHIT-727 QA — on the Budgets tab, a family lifted by its behind-pace sub-budget shows above an
// on-pace budget listed before it, with the sub directly under its parent. Real ../api over the
// fake server; ../auth + expo-router mocked.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { screen } from '@testing-library/react-native';
import { resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { pinToday } from './support/clock';
import { seedBudgetsTab } from './support/budgetsTab';
import { COFFEE, DINING, SUBSCRIPTIONS } from './support/categories';

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

// [A4] (P0) the whole family moves up on screen, sub-budget still directly under its parent.
it('shows a family with a behind-pace sub above an on-pace budget, sub under its parent', async () => {
  // 7 of 14 days left → pace is half the budget. Subscriptions $50/$100 on pace; Coffee
  // $100/$200 on pace; its sub Dining $45/$50 is over plan.
  seedBudgetsTab(
    server,
    {
      subs: { target: 100, posted: 50, pending: 0 },
      coffee: { target: 200, posted: 100, pending: 0 },
      dining: { target: 50, posted: 45, pending: 0 },
    },
    [SUBSCRIPTIONS, COFFEE, { ...DINING, parent: 'coffee' }],
  );
  await renderWithQueries(<Budgets />);
  await screen.findByText('Dining');
  const order = screen.getAllByText(/^(Cafes & Coffee|Dining|Subscriptions)$/).map((n) => n.props.children);
  expect(order).toEqual(['Cafes & Coffee', 'Dining', 'Subscriptions']);
});
