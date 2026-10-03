// WHIT-712 — the Budgets tab rows on screen: an on-pace row is quiet (no "on pace"), an
// over-budget row says the overspend once, and rows never show carried-over / borrowed text.
// Real ../api over the fake server; ../auth + expo-router mocked.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { screen } from '@testing-library/react-native';
import { resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { seedBudgetsTab } from './support/budgetsTab';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Budgets from '../../app/(tabs)/budgets';

const server = installFakeServer();
useTestQueryClient();

// 14-day cycle, 7 days left → halfway, so a $100 budget's pace target is $50.
const seed = (coffee: Record<string, unknown>) => seedBudgetsTab(server, { coffee });

beforeEach(() => {
  resetRouter();
  resetAuth();
});

it('an on-pace row shows the money line and no pace line', async () => {
  seed({ target: 100, posted: 50, pending: 0 });
  await renderWithQueries(<Budgets />);
  await screen.findByText('Cafes & Coffee');
  expect(screen.getByText('$50 of $100')).toBeTruthy();
  expect(screen.queryByText(/on pace/)).toBeNull();
});

it('an over-budget row with no spread shows the overspend once', async () => {
  seed({ target: 100, posted: 120, pending: 0, rollover: true, carryover: 0 });
  await renderWithQueries(<Budgets />);
  await screen.findByText('Cafes & Coffee');
  expect(screen.getByText('$20')).toBeTruthy();
  expect(screen.getByText('over')).toBeTruthy();
  expect(screen.queryByText(/over budget/)).toBeNull();
});

it('a rollover row shows no carried-over or borrowed text', async () => {
  seed({ target: 100, posted: 0, pending: 0, rollover: true, carryover: 200 });
  await renderWithQueries(<Budgets />);
  await screen.findByText('Cafes & Coffee');
  expect(screen.queryByText(/carried over|borrowed/)).toBeNull();
});
